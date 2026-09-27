import { afterAll, describe, expect, test } from "bun:test"
import {
  FakeRunner,
  T0,
  cleanupAllTempDirs,
  cleanupDir,
  makeAdapter,
  observerOutput,
  openEngine,
  tempDir,
  textOfTokens,
  track,
  userMsg,
} from "./helpers"

afterAll(cleanupAllTempDirs)

function messages(sessionId: string, count: number, tokens: number, at = T0) {
  return Array.from({ length: count }, (_, i) =>
    userMsg(textOfTokens(tokens, `activation-${i}`), {
      id: `${sessionId}-m${i + 1}`,
      sessionID: sessionId,
      at: at + i,
    }),
  )
}

async function eventually(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}

describe("observation activation", () => {
  test("buffer chunks queue below activation without calling the runner", async () => {
    const runner = new FakeRunner().always(observerOutput([]))
    const h = await openEngine({ runner })
    const rows = messages("ses_a", 2, 45)
    const adapter = makeAdapter(runner, { directory: h.dir, messages: rows })
    try {
      h.engine.register(adapter, T0)
      track(h.engine, adapter, { id: "ses_a" }, T0)
      h.engine.ingest("ses_a", rows, { now: T0 })
      await Bun.sleep(20)

      expect(runner.requests).toHaveLength(0)
      expect(
        h.engine.db
          .prepare("SELECT state, reason, COUNT(*) AS n FROM chunks WHERE session_id = ? GROUP BY state, reason")
          .all<{ state: string; reason: string; n: number }>("ses_a"),
      ).toEqual([{ state: "pending", reason: "buffer", n: 2 }])
      expect(h.engine.sessionStatus("ses_a").unobservedTokens).toBe(90)
    } finally {
      await h.close()
    }
  })

  test("crossing activation drains every queued fixed chunk and leaves the partial tail", async () => {
    const runner = new FakeRunner().always(observerOutput([]))
    const h = await openEngine({ runner })
    const rows = [
      ...messages("ses_a", 4, 45),
      userMsg(textOfTokens(20, "activation-tail"), { id: "ses_a-m5", sessionID: "ses_a", at: T0 + 10 }),
    ]
    let visible = rows.slice(0, 4)
    const adapter = makeAdapter(runner, { directory: h.dir, messages: () => visible })
    try {
      h.engine.register(adapter, T0)
      track(h.engine, adapter, { id: "ses_a" }, T0)
      h.engine.ingest("ses_a", visible, { now: T0 })
      await Bun.sleep(20)
      expect(runner.requests).toHaveLength(0)

      visible = rows
      h.engine.ingest("ses_a", visible, { now: T0 + 10 })
      await eventually(() => runner.requests.length === 4)

      const status = h.engine.sessionStatus("ses_a")
      expect(status.chunks.succeeded).toEqual({ n: 4, tokens: 180 })
      expect(status.chunks.pending).toBeUndefined()
      expect(status.unchunkedTokens).toBe(20)
      expect(status.unobservedTokens).toBe(20)
    } finally {
      await h.close()
    }
  })

  test("explicit flush bypasses activation for already queued buffer chunks", async () => {
    const runner = new FakeRunner().always(observerOutput([]))
    const h = await openEngine({ runner })
    const rows = messages("ses_a", 2, 45)
    const otherRows = messages("ses_b", 2, 45)
    const adapter = makeAdapter(runner, { directory: h.dir, messages: rows })
    try {
      h.engine.register(adapter, T0)
      track(h.engine, adapter, { id: "ses_a" }, T0)
      track(h.engine, adapter, { id: "ses_b" }, T0)
      h.engine.ingest("ses_a", rows, { now: T0 })
      h.engine.ingest("ses_b", otherRows, { now: T0 })
      await Bun.sleep(20)
      expect(runner.requests).toHaveLength(0)

      const flushed = await h.engine.flush("ses_a", { wait: true, timeoutMs: 2_000 })
      expect(flushed.waited).toBe(true)
      expect(flushed.outcomes).toHaveLength(2)
      expect(runner.requests).toHaveLength(2)
      expect(h.engine.sessionStatus("ses_a").coveredSeq).toBe(2)
      expect(h.engine.sessionStatus("ses_b").chunks.pending).toEqual({ n: 2, tokens: 90 })
    } finally {
      await h.close()
    }
  })

  test("idle, max-age, and startup recovery process small sessions below activation", async () => {
    for (const reason of ["idle", "age"] as const) {
      const runner = new FakeRunner().always(observerOutput([]))
      const patch =
        reason === "idle"
          ? { observe: { idleFlushMs: 1_000, maxUnobservedAgeMs: 10_000 } }
          : { observe: { idleFlushMs: 10_000, maxUnobservedAgeMs: 1_000 } }
      const h = await openEngine({ runner, patch })
      const rows = messages(`ses_${reason}`, 1, 20)
      const adapter = makeAdapter(runner, { directory: h.dir, messages: rows })
      try {
        h.engine.register(adapter, T0)
        track(h.engine, adapter, { id: `ses_${reason}` }, T0)
        h.engine.ingest(`ses_${reason}`, rows, { now: T0 })
        expect(h.engine.scheduleCuts(`ses_${reason}`, T0 + 1_001)?.reason).toBe(reason)
        await eventually(() => runner.requests.length === 1)
        expect(h.engine.sessionStatus(`ses_${reason}`).coveredSeq).toBe(1)
      } finally {
        await h.close()
      }
    }

    const dir = tempDir()
    const dbPath = `${dir}\\memory.db`
    const first = await openEngine({ dbPath })
    const staleRows = messages("ses_recovery", 1, 20)
    const staleQueuedRows = messages("ses_recovery_queued", 2, 45)
    const firstAdapter = makeAdapter(first.runner, { directory: dir, messages: staleRows })
    try {
      first.engine.register(firstAdapter, T0)
      track(first.engine, firstAdapter, { id: "ses_recovery" }, T0)
      track(first.engine, firstAdapter, { id: "ses_recovery_queued" }, T0)
      first.engine.unregister(firstAdapter.id)
      first.engine.ingest("ses_recovery", staleRows, { now: T0 })
      first.engine.ingest("ses_recovery_queued", staleQueuedRows, { now: T0 })
    } finally {
      await first.close()
    }

    const recoveryRunner = new FakeRunner().always(observerOutput([]))
    const reopened = await openEngine({ runner: recoveryRunner, dbPath })
    const recoveryAdapter = makeAdapter(recoveryRunner, { directory: dir, messages: staleRows })
    try {
      reopened.engine.register(recoveryAdapter)
      await eventually(() => recoveryRunner.requests.length === 3)
      expect(
        reopened.engine.db.prepare("SELECT DISTINCT reason FROM chunks ORDER BY reason").all<{ reason: string }>(),
      ).toEqual([{ reason: "buffer:recovery" }, { reason: "recovery" }])
      expect(reopened.engine.sessionStatus("ses_recovery").coveredSeq).toBe(1)
      expect(reopened.engine.sessionStatus("ses_recovery_queued").coveredSeq).toBe(2)
    } finally {
      await reopened.close()
      cleanupDir(dir)
    }
  })

  test("restart preserves queued pre-threshold chunks until later input activates them", async () => {
    const dir = tempDir()
    const dbPath = `${dir}\\memory.db`
    const now = Date.now()
    const rows = messages("ses_restart", 5, 45, now)
    const first = await openEngine({ dbPath })
    const firstAdapter = makeAdapter(first.runner, { directory: dir, messages: rows.slice(0, 2) })
    try {
      first.engine.register(firstAdapter, now)
      track(first.engine, firstAdapter, { id: "ses_restart" }, now)
      first.engine.unregister(firstAdapter.id)
      first.engine.ingest("ses_restart", rows.slice(0, 2), { now })
      expect(first.engine.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE reason = 'buffer'").get<{ n: number }>()?.n).toBe(2)
    } finally {
      await first.close()
    }

    const runner = new FakeRunner().always(observerOutput([]))
    let visible = rows.slice(0, 2)
    const reopened = await openEngine({ runner, dbPath })
    const adapter = makeAdapter(runner, { directory: dir, messages: () => visible })
    try {
      reopened.engine.register(adapter, now + 10)
      await Bun.sleep(20)
      expect(runner.requests).toHaveLength(0)
      expect(reopened.engine.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE reason = 'buffer'").get<{ n: number }>()?.n).toBe(2)

      visible = rows
      reopened.engine.ingest("ses_restart", visible, { now: now + 20 })
      await eventually(() => runner.requests.length === 4)
      expect(reopened.engine.sessionStatus("ses_restart").chunks.succeeded?.n).toBe(4)
    } finally {
      await reopened.close()
      cleanupDir(dir)
    }
  })

  test("activationTokens zero starts automatic observation immediately", async () => {
    const runner = new FakeRunner().always(observerOutput([]))
    const h = await openEngine({ runner, patch: { observe: { activationTokens: 0 } } })
    const rows = messages("ses_zero", 2, 45)
    const adapter = makeAdapter(runner, { directory: h.dir, messages: rows })
    try {
      h.engine.register(adapter, T0)
      track(h.engine, adapter, { id: "ses_zero" }, T0)
      h.engine.ingest("ses_zero", rows, { now: T0 })
      await eventually(() => runner.requests.length === 2)
      expect(h.engine.sessionStatus("ses_zero").coveredSeq).toBe(2)
    } finally {
      await h.close()
    }
  })
})
