import { afterAll, describe, expect, test } from "bun:test"
import { CUT, T0, FakeRunner, RunnerError, assistantMsg, cleanupAllTempDirs, defaultConfig, ingest, observerOutput, openHarness, seed, textOfTokens, userMsg } from "./helpers"
import { claimChunk, contiguousCoverage, coveredRanges, cutChunks, failChunk } from "../src/chunks"
import { observeNext } from "../src/observer"

afterAll(cleanupAllTempDirs)

async function sessionWith(n: number, tokens = 20) {
  const h = await openHarness()
  const { sessionId } = seed(h.db)
  const messages = []
  for (let i = 0; i < n; i++) {
    messages.push(i % 2 === 0 ? userMsg(textOfTokens(tokens, `u${i}`), { id: `u${i}`, at: T0 + i }) : assistantMsg(textOfTokens(tokens, `a${i}`), { id: `a${i}`, at: T0 + i }))
  }
  ingest(h.db, sessionId, messages)
  cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })
  return { h, sessionId }
}

function claim(h: Awaited<ReturnType<typeof openHarness>>, owner = "w1", now = T0) {
  return claimChunk(h.db, owner, { leaseMs: 30_000, now })!
}

describe("failure handling", () => {
  test("oversize splits into children that exactly cover the parent range", async () => {
    const { h, sessionId } = await sessionWith(4, 20)
    try {
      const c = claim(h)
      expect(c.chunk.start_seq).toBe(1)
      expect(c.chunk.end_seq).toBe(4)
      const out = failChunk(h.db, c, { cls: "oversize", message: "too big" }, { maxAttempts: 3, now: T0 + 1 })
      expect(out).toBe("split")
      const parent = h.db.prepare("SELECT state FROM chunks WHERE id = ?").get<{ state: string }>(c.chunk.id)
      expect(parent?.state).toBe("split")
      const kids = h.db
        .prepare("SELECT start_seq, end_seq, parent_id, state FROM chunks WHERE parent_id = ? ORDER BY start_seq")
        .all<{ start_seq: number; end_seq: number; parent_id: string; state: string }>(c.chunk.id)
      expect(kids.length).toBe(2)
      expect(kids[0].start_seq).toBe(1)
      expect(kids[1].end_seq).toBe(4)
      expect(kids[0].end_seq + 1).toBe(kids[1].start_seq)
      expect(kids.every((k) => k.state === "pending")).toBe(true)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage WHERE session_id = ?").get<{ n: number }>(sessionId)!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("invalid_output retries then splits a multi-message chunk", async () => {
    const { h } = await sessionWith(2, 20)
    try {
      let now = T0
      const parent = claim(h, "w1", now)
      expect(failChunk(h.db, parent, { cls: "invalid_output", message: "bad json" }, { maxAttempts: 3, now })).toBe("retry")
      now += 10_000
      const c2 = claim(h, "w1", now)
      expect(c2.chunk.id).toBe(parent.chunk.id)
      expect(failChunk(h.db, c2, { cls: "invalid_output", message: "bad json" }, { maxAttempts: 3, now })).toBe("retry")
      now += 10_000
      const c3 = claim(h, "w1", now)
      expect(failChunk(h.db, c3, { cls: "invalid_output", message: "bad json" }, { maxAttempts: 3, now })).toBe("split")
      const kids = h.db
        .prepare("SELECT id, start_seq, end_seq FROM chunks WHERE parent_id = ? ORDER BY start_seq")
        .all<{ id: string; start_seq: number; end_seq: number }>(parent.chunk.id)
      expect(kids.length).toBe(2)
      expect(kids[0].start_seq).toBe(1)
      expect(kids[1].end_seq).toBe(2)
      expect(kids[0].end_seq + 1).toBe(kids[1].start_seq)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("invalid_output quarantines a single-message chunk after maxAttempts", async () => {
    const { h } = await sessionWith(1, 20)
    try {
      let now = T0
      let last = "retry"
      for (let i = 0; i < 3; i++) {
        const c = claim(h, "w1", now)
        last = failChunk(h.db, c, { cls: "invalid_output", message: "still bad" }, { maxAttempts: 3, now })
        now += 10_000
      }
      expect(last).toBe("quarantined")
      expect(h.db.prepare("SELECT state FROM chunks").get<{ state: string }>()?.state).toBe("quarantined")
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("transient backs off until maxAttempts*2 then quarantines a singleton", async () => {
    const { h } = await sessionWith(1, 20)
    try {
      const maxAttempts = 3
      let now = T0
      let last = "retry"
      for (let i = 0; i < maxAttempts * 2; i++) {
        const c = claim(h, "w1", now)
        last = failChunk(h.db, c, { cls: "transient", message: "timeout" }, { maxAttempts, now })
        const row = h.db.prepare("SELECT attempts, state, next_attempt_at FROM chunks WHERE id = ?").get<{ attempts: number; state: string; next_attempt_at: number | null }>(c.chunk.id)!
        if (i < maxAttempts * 2 - 1) {
          expect(last).toBe("retry")
          expect(row.attempts).toBe(i + 1)
          expect(row.state).toBe("retryable")
          expect(row.next_attempt_at).toBeGreaterThan(now)
        }
        now += 20 * 60_000
      }
      expect(last).toBe("quarantined")
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("rate_limit backs off without incrementing attempts", async () => {
    const { h } = await sessionWith(1, 20)
    try {
      const c = claim(h)
      expect(c.chunk.attempts).toBe(0)
      const out = failChunk(h.db, c, { cls: "rate_limit", message: "429", retryAfterMs: 30_000 }, { maxAttempts: 3, now: T0 })
      expect(out).toBe("retry")
      const row = h.db.prepare("SELECT attempts, state, next_attempt_at, error_class FROM chunks WHERE id = ?").get<{
        attempts: number
        state: string
        next_attempt_at: number
        error_class: string
      }>(c.chunk.id)!
      expect(row.attempts).toBe(0)
      expect(row.state).toBe("retryable")
      expect(row.error_class).toBe("rate_limit")
      expect(row.next_attempt_at).toBe(T0 + 30_000)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("auth, cost_limit, and aborted pause without counting an attempt", async () => {
    for (const cls of ["auth", "cost_limit", "aborted"] as const) {
      const { h } = await sessionWith(1, 20)
      try {
        const c = claim(h)
        const out = failChunk(h.db, c, { cls, message: cls }, { maxAttempts: 3, now: T0 })
        expect(out).toBe("paused")
        const row = h.db.prepare("SELECT attempts, state FROM chunks WHERE id = ?").get<{ attempts: number; state: string }>(c.chunk.id)!
        expect(row.attempts).toBe(0)
        expect(row.state).toBe("pending")
        expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(0)
      } finally {
        h.close()
      }
    }
  })

  test("contiguousCoverage is the prefix of successful coverage only", async () => {
    const { h, sessionId } = await sessionWith(4, 20)
    try {
      h.db.prepare("INSERT INTO coverage(chunk_id, session_id, start_seq, end_seq, created_at) VALUES (?,?,?,?,?)").run("c1", sessionId, 1, 2, T0)
      h.db.prepare("INSERT INTO coverage(chunk_id, session_id, start_seq, end_seq, created_at) VALUES (?,?,?,?,?)").run("c2", sessionId, 4, 4, T0)
      expect(contiguousCoverage(h.db, sessionId)).toBe(2)
      expect(coveredRanges(h.db, sessionId)).toEqual([
        [1, 2],
        [4, 4],
      ])
      h.db.prepare("INSERT INTO coverage(chunk_id, session_id, start_seq, end_seq, created_at) VALUES (?,?,?,?,?)").run("c3", sessionId, 3, 3, T0)
      expect(contiguousCoverage(h.db, sessionId)).toBe(4)
    } finally {
      h.close()
    }
  })

  test("coverage is never recorded for a failed observeNext run", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, [userMsg("please explain hashing", { id: "u1" }), assistantMsg("hashing is...", { id: "a1", at: T0 + 1 })])
      cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })
      const runner = new FakeRunner().enqueue(new RunnerError("invalid_output", "not json"))
      const cfg = defaultConfig(h.dir)
      const r = await observeNext({ db: h.db, config: cfg, runner, owner: "w1", now: () => T0 + 5 })
      expect(r?.status).toBe("retry")
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(0)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM observations").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("a successful observeNext writes coverage for the claimed range", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, [userMsg("I prefer dark mode", { id: "u1" }), assistantMsg("noted", { id: "a1", at: T0 + 1 })])
      cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })
      const runner = new FakeRunner().enqueue(
        observerOutput([{ content: "User prefers dark mode", sources: { start: "m1", end: "m1" }, quote: "I prefer dark mode", evidenceType: "explicit", kind: "preference" }]),
      )
      const r = await observeNext({ db: h.db, config: defaultConfig(h.dir), runner, owner: "w1", now: () => T0 + 5 })
      expect(r?.status).toBe("succeeded")
      expect(contiguousCoverage(h.db, sessionId)).toBe(2)
    } finally {
      h.close()
    }
  })
})
