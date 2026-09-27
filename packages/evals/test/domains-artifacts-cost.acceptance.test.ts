import "./hermetic"
import { afterAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  RunnerError,
  conceptState,
  dueReviews,
  recordAttempt,
  reserveRun,
  settleRun,
  usageToday,
} from "@opencode-memory/core"
import {
  T0,
  ScriptedRunner,
  adapter,
  cleanupAll,
  cleanupDir,
  openEngine,
  tempDir,
} from "./fixtures"

afterAll(cleanupAll)

const DAY = 86_400_000

describe("acceptance: learning, research, artifacts, and budget", () => {
  test("schedules FSRS reviews while mastery distinguishes independent, assisted, and recalled evidence", async () => {
    const h = await openEngine()
    const runner = new ScriptedRunner()
    const instance = adapter({ runner, directory: h.dir, domain: "learning" })
    try {
      h.engine.register(instance, T0)
      h.engine.trackSession(instance, { id: "learn-session" }, T0)
      const ctx = h.engine.context("project-a", "learn-session")
      const attempt = (content: string, at: number, hints: number, independent: boolean) => {
        const result = h.engine.remember(
          ctx,
          {
            content,
            actor: "user",
            scope: "workspace",
            sessionId: "learn-session",
            kind: "quiz-attempt",
            payload: {
              concept: "Recursion",
              question: "What is a base case?",
              answer: content,
              evaluation: "correct",
              hints,
              independent,
            },
          },
          at,
        )
        if (!result.ok) throw new Error(result.error)
        return result.id
      }
      const assisted = attempt("Answered correctly after two hints", T0, 2, true)
      attempt("Answered independently on day one", T0 + DAY, 0, true)
      attempt("Answered independently after spacing", T0 + 5 * DAY, 0, true)
      const mastery = h.engine.remember(
        ctx,
        {
          content: "Demonstrated recursive tree traversal",
          actor: "user",
          scope: "workspace",
          sessionId: "learn-session",
          kind: "demonstrated-skill",
          payload: { concept: "Recursion", evaluation: "correct", independent: false, mastery: true },
        },
        T0 + 6 * DAY,
      )
      expect(mastery.ok).toBe(true)

      const conceptId = h.engine.db.prepare("SELECT id FROM learning_concepts WHERE workspace = 'workspace-a'").get<{ id: string }>()!.id
      const state = conceptState(h.engine.db, conceptId, T0 + 6 * DAY)!
      expect(state).toMatchObject({
        level: "retained",
        attempts: 4,
        independentCorrect: 2,
        assisted: 2,
        distinctDays: 2,
        approvedMastery: true,
      })
      const assistedRow = h.engine.db
        .prepare("SELECT independent, hints FROM learning_attempts WHERE observation_id = ?")
        .get<{ independent: number; hints: number }>(assisted)
      expect(assistedRow).toEqual({ independent: 0, hints: 2 })
      const before = h.engine.db.prepare("SELECT COUNT(*) AS n FROM learning_attempts").get<{ n: number }>()!.n
      expect(
        recordAttempt(h.engine.db, {
          workspace: "workspace-a",
          observationId: assisted,
          sessionId: "learn-session",
          kind: "quiz-attempt",
          payload: { concept: "Recursion", evaluation: "correct", independent: true },
          at: T0 + 7 * DAY,
          fromRecall: true,
        }),
      ).toBeUndefined()
      expect(h.engine.db.prepare("SELECT COUNT(*) AS n FROM learning_attempts").get<{ n: number }>()!.n).toBe(before)
      expect(dueReviews(h.engine.db, "workspace-a", T0 + 365 * DAY).map((row) => row.name)).toContain("Recursion")
    } finally {
      await h.engine.close()
      cleanupDir(h.dir)
    }
  }, 15_000)

  test("builds scoped research claims, sources, opposing stances, and conflicts", async () => {
    const h = await openEngine()
    const runner = new ScriptedRunner()
    const instance = adapter({ runner, directory: h.dir, domain: "research" })
    try {
      h.engine.register(instance, T0)
      h.engine.trackSession(instance, { id: "research-session" }, T0)
      const ctx = h.engine.context("project-a", "research-session")
      const statement = "Spaced retrieval improves delayed vocabulary retention"
      const remember = (kind: "claim" | "evidence" | "counter-evidence", content: string, payload: Record<string, unknown>) => {
        const result = h.engine.remember(
          ctx,
          { content, kind, actor: "user", scope: "workspace", sessionId: "research-session", payload },
          T0,
        )
        if (!result.ok) throw new Error(result.error)
      }
      remember("claim", statement, {
        claim: statement,
        url: "https://example.test/study",
        title: "Retention Study",
        conditions: "adult language learners",
      })
      remember("evidence", "The intervention group retained more words after thirty days", {
        claim: statement,
        stance: "support",
        url: "https://example.test/study",
        quotation: "retained more words after thirty days",
        locator: "p. 9",
      })
      remember("counter-evidence", "A replication found no measurable delayed benefit", {
        claim: statement,
        stance: "contradict",
        url: "https://example.test/replication",
        quotation: "no measurable delayed benefit",
      })

      const research = h.engine.research("workspace-a")
      expect(research.claims).toHaveLength(1)
      expect(research.claims[0]).toMatchObject({ statement, status: "contested" })
      expect(research.claims[0].support.length).toBeGreaterThanOrEqual(1)
      expect(research.claims[0].contradict).toHaveLength(1)
      expect(research.sources).toHaveLength(2)
      expect(research.conflicts.map((claim) => claim.statement)).toEqual([statement])
      expect(h.engine.research("another-workspace")).toEqual({ claims: [], conflicts: [], sources: [] })
    } finally {
      await h.engine.close()
      cleanupDir(h.dir)
    }
  })

  test("registers and indexes supported artifacts only inside the project boundary", async () => {
    const h = await openEngine()
    const outside = tempDir()
    const runner = new ScriptedRunner()
    const instance = adapter({ runner, directory: h.dir })
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><title>Acceptance diagram</title><rect width="1" height="1"/></svg>`
    try {
      h.engine.register(instance, T0)
      h.engine.trackSession(instance, { id: "artifact-session" }, T0)
      writeFileSync(join(h.dir, "inside.svg"), svg)
      writeFileSync(join(outside, "outside.svg"), svg)
      const inside = h.engine.captureToolArtifacts(instance, "artifact-session", "write", { filePath: "inside.svg" })
      const escaped = h.engine.captureToolArtifacts(instance, "artifact-session", "write", { filePath: join(outside, "outside.svg") })
      const inline = h.engine.captureInlineArtifacts(
        instance,
        "artifact-session",
        "assistant-artifact",
        "```mermaid\n%% Acceptance flow\ngraph TD\nA-->B\n```",
      )
      expect(inside).toHaveLength(1)
      expect(escaped).toEqual([])
      expect(inline).toHaveLength(1)
      const indexed = h.engine.artifacts({ workspace: "workspace-a" })
      expect(indexed).toHaveLength(2)
      expect(indexed.map((row) => row.kind).sort()).toEqual(["mermaid", "svg"])
      expect(indexed.some((row) => row.path.includes("outside.svg"))).toBe(false)
      expect(h.engine.artifactContent(inside[0]!)?.content).toContain("Acceptance diagram")
    } finally {
      await h.engine.close()
      cleanupDir(h.dir)
      cleanupDir(outside)
    }
  })

  test("blocks another model run once settled token usage reaches the daily cap", async () => {
    const h = await openEngine()
    try {
      const config = { dailyCapUsd: 10, dailyTokenCap: 100, estimatePerRunUsd: 0.01 }
      const id = reserveRun(h.engine.db, config, { kind: "observe", runner: "acceptance" }, T0)
      settleRun(h.engine.db, id, { cost: 0.01, inputTokens: 75, outputTokens: 25, status: "succeeded" }, T0 + 1)
      expect(usageToday(h.engine.db, T0 + 1).tokens).toBe(100)
      try {
        reserveRun(h.engine.db, config, { kind: "observe", runner: "acceptance" }, T0 + 2)
        throw new Error("expected token cap")
      } catch (error) {
        expect(error).toBeInstanceOf(RunnerError)
        expect((error as RunnerError).cls).toBe("cost_limit")
        expect((error as Error).message).toContain("token cap")
      }
      try {
        reserveRun(
          h.engine.db,
          { dailyCapUsd: 0.005, dailyTokenCap: 10_000, estimatePerRunUsd: 0.001 },
          { kind: "observe", runner: "acceptance" },
          T0 + 2,
        )
        throw new Error("expected cost cap")
      } catch (error) {
        expect(error).toBeInstanceOf(RunnerError)
        expect((error as RunnerError).cls).toBe("cost_limit")
        expect((error as Error).message).toContain("cost cap")
      }
    } finally {
      await h.engine.close()
      cleanupDir(h.dir)
    }
  })
})
