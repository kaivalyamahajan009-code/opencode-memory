import { afterAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { T0, cleanupAllTempDirs, openEngine, openHarness, putObservation, seed } from "./helpers"
import { loadConfig, parseConfigPatch } from "../src/config"
import { buildMemoryBlock, isInternalSystem, MEMORY_BLOCK_TAG } from "../src/inject"
import { upsertConcept } from "../src/learning"
import type { Database } from "../src/sqlite"

afterAll(cleanupAllTempDirs)

describe("injection", () => {
  test("isInternalSystem detects title/summary/observer prompts and already-injected blocks", () => {
    expect(isInternalSystem(["You are a title generator for this conversation"])).toBe(true)
    expect(isInternalSystem(["Summarize what was done in this conversation so far"])).toBe(true)
    expect(isInternalSystem(["You are a context summarization agent."])).toBe(true)
    expect(isInternalSystem(["You are the Observer for a personal memory system."])).toBe(true)
    expect(isInternalSystem(["You are the Reflector for a personal memory system."])).toBe(true)
    expect(isInternalSystem([`hello <${MEMORY_BLOCK_TAG} generation="1">x</${MEMORY_BLOCK_TAG}>`])).toBe(true)
    expect(isInternalSystem(["You are a helpful coding assistant."])).toBe(false)
  })

  test("buildMemoryBlock respects section budgets and excludes other projects", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" })
      seed(h.db, { projectId: "proj_b", workspace: "other", sessionId: "ses_b" })
      for (let i = 0; i < 12; i++) {
        putObservation(h.db, {
          workspace: "learn",
          projectId: null,
          sessionId: null,
          scopeKind: "user",
          content: `User profile fact number ${i} with extra padding words for tokens`,
          now: T0 + i,
        })
      }
      putObservation(h.db, {
        workspace: "other",
        projectId: "proj_b",
        sessionId: "ses_b",
        scopeKind: "project",
        content: "secret project B only content that must never be injected into A",
      })
      putObservation(h.db, {
        workspace: "learn",
        projectId: "proj_a",
        sessionId: "ses_a",
        scopeKind: "project",
        content: "project A unique context about the widget API",
      })
      const result = buildMemoryBlock(h.db, {
        ctx: { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" },
        domain: "learning",
        budget: { profile: 40, workspace: 40, project: 80, session: 40, task: 40, recall: 40 },
        now: T0 + 100,
      })
      const profile = result.sections.find((s) => s.name === "profile")
      expect(profile).toBeTruthy()
      expect(profile!.tokens).toBeLessThanOrEqual(40)
      expect(result.block).not.toContain("secret project B")
      expect(result.block).toContain("widget API")
    } finally {
      h.close()
    }
  })

  test("pending_review items queued by the user are marked unconfirmed", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" })
      putObservation(h.db, {
        workspace: "learn",
        projectId: "proj_a",
        sessionId: "ses_a",
        scopeKind: "session",
        status: "pending_review",
        actor: "user",
        content: "Unconfirmed session hypothesis about the bug",
        reviewReason: "needs review",
        targetScope: "project",
      })
      const result = buildMemoryBlock(h.db, {
        ctx: { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" },
        domain: "general",
        budget: { profile: 80, workspace: 80, project: 80, session: 200, task: 40, recall: 80 },
        now: T0,
      })
      expect(result.block).toContain("unconfirmed")
      expect(result.block).toContain("Unconfirmed session hypothesis")
    } finally {
      h.close()
    }
  })

  test("engine.commitInjection skips om-*, title, summary, compaction and dedupes per request key", async () => {
    const ctx = await openEngine()
    try {
      const { engine } = ctx
      engine.db.prepare("INSERT INTO projects(id, workspace, domain, name, directory, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
        "proj_a",
        "learn",
        "learning",
        "A",
        ctx.dir,
        T0,
        T0,
      )
      engine.db
        .prepare("INSERT INTO sessions(id, project_id, title, internal, excluded, created_at, updated_at, last_activity_at) VALUES (?,?,?,0,0,?,?,?)")
        .run("ses_a", "proj_a", "ses_a", T0, T0, T0)
      putObservation(engine.db, {
        workspace: "learn",
        projectId: "proj_a",
        sessionId: "ses_a",
        scopeKind: "user",
        content: "User likes dark mode in every editor",
      })
      const built = await engine.buildInjection("ses_a", "dark mode")
      expect(built?.block).toBeTruthy()
      const id1 = engine.commitInjection("ses_a", "req-1", "build")
      expect(id1).toBeTruthy()
      expect(engine.commitInjection("ses_a", "req-1", "build")).toBeUndefined()
      await engine.buildInjection("ses_a", "dark mode", "req-1")
      const id2 = engine.commitInjection("ses_a", "req-1", "build")
      expect(id2).toBe(id1)
      expect(engine.commitInjection("ses_a", "req-2", "om-observer")).toBeUndefined()
      expect(engine.commitInjection("ses_a", "req-2", "title")).toBeUndefined()
      expect(engine.commitInjection("ses_a", "req-2", "summary")).toBeUndefined()
      expect(engine.commitInjection("ses_a", "req-2", "compaction")).toBeUndefined()
      await engine.buildInjection("ses_a", "dark mode", "req-2")
      const id3 = engine.commitInjection("ses_a", "req-2", "build")
      expect(id3).toBeTruthy()
      expect(id3).not.toBe(id1)
      expect(engine.db.prepare("SELECT COUNT(*) AS n FROM context_snapshots").get<{ n: number }>()!.n).toBe(2)
    } finally {
      await ctx.close()
    }
  })

  function dueCard(db: Database, workspace: string, name: string) {
    const id = upsertConcept(db, workspace, name, T0)
    db.prepare("INSERT INTO review_cards(concept_id, card, due_at, reps, lapses) VALUES (?,?,?,?,?)").run(id, "{}", T0 - 1, 0, 0)
  }

  test("buildInjection override replaces domain and workspace; omitted override keeps the project", async () => {
    const ctx = await openEngine()
    try {
      seed(ctx.engine.db, {
        projectId: "proj_gen",
        workspace: "personal-knowledge",
        sessionId: "ses_gen",
        domain: "general",
        directory: ctx.dir,
      })
      dueCard(ctx.engine.db, "learning", "Photosynthesis")
      dueCard(ctx.engine.db, "personal-knowledge", "ProjectOnlyConcept")
      expect(ctx.engine.projectDomain("proj_gen")).toBe("general")
      expect(ctx.engine.config.inject.learningAgents).toEqual(["learn"])

      const plain = await ctx.engine.buildInjection("ses_gen", "review")
      expect(plain?.block ?? "").not.toContain("Concepts due for review")

      const projectLearning = await ctx.engine.buildInjection("ses_gen", "review", "req-project", { domain: "learning" })
      expect(projectLearning?.block).toContain("Concepts due for review: ProjectOnlyConcept")
      expect(projectLearning?.block).not.toContain("Photosynthesis")

      const shared = await ctx.engine.buildInjection("ses_gen", "review", "req-shared", { domain: "learning", workspace: "learning" })
      expect(shared?.block).toContain("Concepts due for review: Photosynthesis")
      expect(shared?.block).not.toContain("ProjectOnlyConcept")
    } finally {
      await ctx.close()
    }
  })

  test("inject.learningAgents defaults to learn and round-trips through config.json", async () => {
    const ctx = await openEngine()
    try {
      const path = join(ctx.dir, "config.json")
      writeFileSync(path, JSON.stringify({ inject: { learningAgents: ["tutor"] } }))
      const loaded = loadConfig(path)
      expect(loaded.inject.learningAgents).toEqual(["tutor"])
      expect(loaded.inject.enabled).toBe(true)
      expect(loaded.inject.deadlineMs).toBe(250)
      expect(() => parseConfigPatch({ inject: { learningAgents: [""] } })).toThrow()
      expect(parseConfigPatch({ inject: { learningAgents: [] } }).inject?.learningAgents).toEqual([])
    } finally {
      await ctx.close()
    }
  })
})
