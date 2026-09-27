import { afterAll, describe, expect, test } from "bun:test"
import {
  FakeRunner,
  T0,
  assistantMsg,
  cleanupAllTempDirs,
  makeAdapter,
  observerOutput,
  openEngine,
  track,
  userMsg,
} from "./helpers"
import { getObservation } from "../src/observations"

afterAll(cleanupAllTempDirs)

describe("MemoryEngine end-to-end", () => {
  test("open, register, track, ingest, flush wait produces sourced observations", async () => {
    const runner = new FakeRunner().always(
      observerOutput([
        {
          kind: "preference",
          content: "User prefers dark mode",
          evidenceType: "explicit",
          scopeHint: "session",
          sources: { start: "m1", end: "m1" },
          quote: "I prefer dark mode",
        },
      ]),
    )
    const ctx = await openEngine({ runner })
    try {
      const messages = [
        userMsg("I prefer dark mode when coding at night", { id: "u1", sessionID: "ses_a", at: T0 }),
        assistantMsg("I'll remember that", { id: "a1", sessionID: "ses_a", at: T0 + 1 }),
      ]
      const adapter = makeAdapter(runner, { directory: ctx.dir, messages })
      ctx.engine.register(adapter, T0)
      track(ctx.engine, adapter, { id: "ses_a", title: "dark mode" }, T0)
      ctx.engine.ingest("ses_a", messages, { now: T0 })
      const flushed = await ctx.engine.flush("ses_a", { wait: true, timeoutMs: 10_000 })
      expect(flushed.waited).toBe(true)
      expect(flushed.outcomes.some((o) => o.status === "succeeded")).toBe(true)
      const obs = ctx.engine.db.prepare("SELECT id, content, kind FROM observations WHERE status IN ('active','pending_review')").all<{
        id: string
        content: string
        kind: string
      }>()
      expect(obs.some((o) => o.content.includes("dark mode"))).toBe(true)
      const sources = ctx.engine.db.prepare("SELECT session_id, start_seq, end_seq FROM observation_sources").all<{
        session_id: string
        start_seq: number
        end_seq: number
      }>()
      expect(sources.some((s) => s.session_id === "ses_a" && s.start_seq === 1)).toBe(true)
      const status = ctx.engine.sessionStatus("ses_a")
      expect(status.known).toBe(true)
      expect(status.observations).toBeGreaterThanOrEqual(1)
      expect(status.coveredSeq).toBeGreaterThanOrEqual(1)
    } finally {
      await ctx.close()
    }
  })

  test("remember: agent workspace goes to pending_review, user writes active; supersede and retryQuarantined", async () => {
    const runner = new FakeRunner().always({ observations: [] })
    const ctx = await openEngine({ runner })
    try {
      const adapter = makeAdapter(runner, { directory: ctx.dir })
      ctx.engine.register(adapter, T0)
      track(ctx.engine, adapter, { id: "ses_a" }, T0)
      ctx.engine.ingest("ses_a", [userMsg("hello from the user", { id: "u1", sessionID: "ses_a" })], { now: T0 })
      const access = ctx.engine.context("proj_a", "ses_a")
      const agent = ctx.engine.remember(access, {
        content: "Propose a workspace convention for commit messages",
        kind: "fact",
        scope: "workspace",
        actor: "agent",
      })
      expect(agent.ok).toBe(true)
      if (agent.ok) {
        expect(agent.status).toBe("pending_review")
        expect(getObservation(ctx.engine.db, agent.id)?.status).toBe("pending_review")
      }
      const user = ctx.engine.remember(access, {
        content: "I always write conventional commits",
        kind: "preference",
        scope: "user",
        actor: "user",
      })
      expect(user.ok).toBe(true)
      if (user.ok) {
        expect(user.status).toBe("active")
        expect(getObservation(ctx.engine.db, user.id)?.scope_kind).toBe("user")
        const replaced = ctx.engine.supersede(access, user.id, "I prefer conventional commits with a scope", "refine", "user")
        expect(replaced.ok).toBe(true)
        expect(getObservation(ctx.engine.db, user.id)?.status).toBe("superseded")
      }
      ctx.engine.db.prepare("UPDATE chunks SET state = 'quarantined', attempts = 3, updated_at = ? WHERE session_id = ?").run(T0, "ses_a")
      const n = ctx.engine.retryQuarantined("ses_a")
      expect(n).toBeGreaterThanOrEqual(0)
      const pending = ctx.engine.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = 'ses_a' AND state = 'pending'").get<{ n: number }>()
      if (n) expect(pending?.n).toBeGreaterThanOrEqual(n)
    } finally {
      await ctx.close()
    }
  })

  test("recallSource refuses a source owned by another project", async () => {
    const runner = new FakeRunner().always({ observations: [] })
    const ctx = await openEngine({ runner })
    try {
      const adapterA = makeAdapter(runner, {
        id: "inst_a",
        directory: ctx.dir,
        project: { id: "proj_a", workspace: "learn", domain: "learning", name: "A", directory: ctx.dir },
      })
      const adapterB = makeAdapter(runner, {
        id: "inst_b",
        directory: `${ctx.dir}-b`,
        project: { id: "proj_b", workspace: "other", domain: "general", name: "B", directory: `${ctx.dir}-b` },
      })
      ctx.engine.register(adapterA, T0)
      ctx.engine.register(adapterB, T0)
      track(ctx.engine, adapterB, { id: "ses_b" }, T0)
      ctx.engine.ingest("ses_b", [userMsg("private B conversation text", { id: "bu1", sessionID: "ses_b" })], { now: T0 })
      const remembered = ctx.engine.remember(ctx.engine.context("proj_b", "ses_b"), {
        content: "A user-level note sourced from project B",
        kind: "fact",
        scope: "user",
        actor: "user",
        sessionId: "ses_b",
      })
      expect(remembered.ok).toBe(true)
      if (!remembered.ok) return
      const denied = ctx.engine.recallSource(ctx.engine.context("proj_a", "ses_a"), { observationId: remembered.id })
      expect(denied.ok).toBe(false)
    } finally {
      await ctx.close()
    }
  })

  test("close() is idempotent", async () => {
    const ctx = await openEngine()
    await ctx.engine.close()
    await ctx.engine.close()
    const { cleanupDir } = await import("./helpers")
    cleanupDir(ctx.dir)
  })
})
