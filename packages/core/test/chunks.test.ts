import { afterAll, describe, expect, test } from "bun:test"
import { CUT, T0, assistantMsg, cleanupAllTempDirs, ingest, openHarness, seed, textOfTokens, userMsg } from "./helpers"
import { cutChunks } from "../src/chunks"
import { unchunkedTokens } from "../src/ingest"

afterAll(cleanupAllTempDirs)

function msgs(n: number, tokens: number, start = T0, prefix = "") {
  const out = []
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant"
    const id = `${prefix}${role === "user" ? "u" : "a"}${i}`
    out.push(role === "user" ? userMsg(textOfTokens(tokens, `w${i}`), { id, at: start + i }) : assistantMsg(textOfTokens(tokens, `w${i}`), { id, at: start + i }))
  }
  return out
}

describe("chunk cutting", () => {
  test("buffer cut leaves the partial tail unchunked", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, msgs(3, 50))
      const ids = cutChunks(h.db, sessionId, "buffer", { bufferTokens: 80, maxChunkTokens: 10_000, minFlushTokens: 10, now: T0 })
      expect(ids.length).toBe(1)
      const chunk = h.db.prepare("SELECT start_seq, end_seq, reason FROM chunks WHERE id = ?").get<{ start_seq: number; end_seq: number; reason: string }>(ids[0])
      expect(chunk?.start_seq).toBe(1)
      expect(chunk?.end_seq).toBe(2)
      expect(chunk?.reason).toBe("buffer")
      const wm = h.db.prepare("SELECT chunked_seq FROM ingest_state WHERE session_id = ?").get<{ chunked_seq: number }>(sessionId)
      expect(wm?.chunked_seq).toBe(2)
      const u = unchunkedTokens(h.db, sessionId)
      expect(u.count).toBe(1)
      expect(u.tokens).toBe(50)
    } finally {
      h.close()
    }
  })

  test("idle flush requires minFlushTokens; age, recovery, and explicit ignore it", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, msgs(1, 5))
      expect(cutChunks(h.db, sessionId, "idle", { ...CUT, minFlushTokens: 10, now: T0 })).toEqual([])
      const age = cutChunks(h.db, sessionId, "age", { ...CUT, minFlushTokens: 10, now: T0 })
      expect(age.length).toBe(1)
      expect(h.db.prepare("SELECT chunked_seq FROM ingest_state WHERE session_id = ?").get<{ chunked_seq: number }>(sessionId)?.chunked_seq).toBe(1)

      const b = seed(h.db, { sessionId: "ses_exp", projectId: "proj_a" })
      ingest(h.db, b.sessionId, msgs(1, 5, T0, "e-"))
      const ids = cutChunks(h.db, b.sessionId, "explicit", { ...CUT, minFlushTokens: 10, now: T0 })
      expect(ids.length).toBe(1)

      const c = seed(h.db, { sessionId: "ses_rec", projectId: "proj_a" })
      ingest(h.db, c.sessionId, msgs(1, 5, T0, "r-"))
      const rec = cutChunks(h.db, c.sessionId, "recovery", { ...CUT, minFlushTokens: 10, now: T0 })
      expect(rec.length).toBe(1)
    } finally {
      h.close()
    }
  })

  test("idle and age flush everything once the min is met", async () => {
    const h = await openHarness()
    try {
      const a = seed(h.db, { sessionId: "ses_idle" })
      ingest(h.db, a.sessionId, msgs(2, 20))
      const idle = cutChunks(h.db, a.sessionId, "idle", { bufferTokens: 80, maxChunkTokens: 10_000, minFlushTokens: 10, now: T0 })
      expect(idle.length).toBe(1)
      expect(h.db.prepare("SELECT start_seq, end_seq FROM chunks WHERE id = ?").get<any>(idle[0])).toMatchObject({ start_seq: 1, end_seq: 2 })

      const b = seed(h.db, { sessionId: "ses_age", projectId: "proj_a" })
      ingest(h.db, b.sessionId, msgs(2, 20, T0, "age-"))
      const age = cutChunks(h.db, b.sessionId, "age", { bufferTokens: 80, maxChunkTokens: 10_000, minFlushTokens: 10, now: T0 })
      expect(age.length).toBe(1)
    } finally {
      h.close()
    }
  })

  test("max chunk size groups messages without splitting a single oversized message", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, msgs(4, 20))
      const ids = cutChunks(h.db, sessionId, "explicit", { bufferTokens: 80, maxChunkTokens: 45, minFlushTokens: 10, now: T0 })
      expect(ids.length).toBe(2)
      const rows = h.db
        .prepare("SELECT start_seq, end_seq, token_est FROM chunks WHERE session_id = ? ORDER BY start_seq")
        .all<{ start_seq: number; end_seq: number; token_est: number }>(sessionId)
      expect(rows).toEqual([
        { start_seq: 1, end_seq: 2, token_est: 40 },
        { start_seq: 3, end_seq: 4, token_est: 40 },
      ])
    } finally {
      h.close()
    }
  })

  test("a single message larger than maxChunkTokens still becomes its own chunk", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, [userMsg(textOfTokens(90, "huge"), { id: "u1" })])
      const ids = cutChunks(h.db, sessionId, "explicit", { bufferTokens: 80, maxChunkTokens: 40, minFlushTokens: 10, now: T0 })
      expect(ids.length).toBe(1)
      const row = h.db.prepare("SELECT start_seq, end_seq, token_est FROM chunks").get<{ start_seq: number; end_seq: number; token_est: number }>()
      expect(row).toEqual({ start_seq: 1, end_seq: 1, token_est: 90 })
    } finally {
      h.close()
    }
  })

  test("cut is idempotent once the watermark catches up", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, msgs(2, 20))
      expect(cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 }).length).toBe(1)
      expect(cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })).toEqual([])
    } finally {
      h.close()
    }
  })
})
