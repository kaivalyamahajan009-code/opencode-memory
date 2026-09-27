import { afterAll, describe, expect, test } from "bun:test"
import { CUT, T0, assistantMsg, cleanupAllTempDirs, ingest, ocMessage, openHarness, seed, textOfTokens, textPart, toolPart, userMsg } from "./helpers"
import { cutChunks } from "../src/chunks"
import { markRemovedMessages } from "../src/ingest"

afterAll(cleanupAllTempDirs)

describe("ingest", () => {
  test("re-ingest of identical messages is idempotent", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      const messages = [userMsg("hello there", { id: "u1", at: T0 }), assistantMsg("hi back", { id: "a1", at: T0 + 10 })]
      const first = ingest(h.db, sessionId, messages)
      expect(first.captured).toBe(2)
      expect(first.lastSeq).toBe(2)
      const second = ingest(h.db, sessionId, messages)
      expect(second.captured).toBe(0)
      expect(second.appendedParts).toBe(0)
      expect(second.lastSeq).toBe(2)
      const msgs = h.db.prepare("SELECT COUNT(*) AS n FROM source_messages WHERE session_id = ?").get<{ n: number }>(sessionId)!
      const parts = h.db.prepare("SELECT COUNT(*) AS n FROM source_parts WHERE session_id = ?").get<{ n: number }>(sessionId)!
      expect(msgs.n).toBe(2)
      expect(parts.n).toBe(2)
    } finally {
      h.close()
    }
  })

  test("incomplete assistant stops the contiguous prefix", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      const messages = [
        userMsg("one", { id: "u1", at: T0 }),
        ocMessage({ role: "assistant", text: "still typing", id: "a1", at: T0 + 10, incomplete: true }),
        userMsg("two", { id: "u2", at: T0 + 20 }),
      ]
      const r = ingest(h.db, sessionId, messages, { now: T0 + 20 })
      expect(r.captured).toBe(1)
      expect(r.pendingIncomplete).toBe(true)
      expect(r.lastSeq).toBe(1)
      const ids = h.db.prepare("SELECT id FROM source_messages WHERE session_id = ? ORDER BY seq").all<{ id: string }>(sessionId)
      expect(ids.map((x) => x.id)).toEqual(["u1"])
    } finally {
      h.close()
    }
  })

  test("stale incomplete assistant is captured with incomplete flag", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      const staleMs = 60_000
      const created = T0
      const now = T0 + staleMs + 1
      const messages = [
        userMsg("ask", { id: "u1", at: created }),
        ocMessage({ role: "assistant", text: "abandoned", id: "a1", at: created, incomplete: true }),
        userMsg("follow up", { id: "u2", at: now }),
      ]
      const r = ingest(h.db, sessionId, messages, { now, staleIncompleteMs: staleMs })
      expect(r.pendingIncomplete).toBe(false)
      expect(r.captured).toBe(3)
      const row = h.db.prepare("SELECT flags FROM source_messages WHERE id = ?").get<{ flags: string | null }>("a1")
      expect(row?.flags).toContain("incomplete")
    } finally {
      h.close()
    }
  })

  test("stopAt skips the revert point and everything after", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      const messages = [
        userMsg("keep", { id: "u1", at: T0 }),
        assistantMsg("also keep", { id: "a1", at: T0 + 10 }),
        userMsg("reverted from here", { id: "u2", at: T0 + 20 }),
        assistantMsg("gone", { id: "a2", at: T0 + 30 }),
      ]
      const r = ingest(h.db, sessionId, messages, { stopAt: "u2" })
      expect(r.captured).toBe(2)
      const ids = h.db.prepare("SELECT id FROM source_messages ORDER BY seq").all<{ id: string }>()
      expect(ids.map((x) => x.id)).toEqual(["u1", "a1"])
    } finally {
      h.close()
    }
  })

  test("parts appended to an already-chunked message create a pending appended chunk", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      const first = ocMessage({
        role: "assistant",
        id: "a1",
        at: T0,
        parts: [textPart("initial answer", "p1")],
      })
      ingest(h.db, sessionId, [userMsg("go", { id: "u1", at: T0 - 10 }), first], { now: T0 })
      const cut = cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })
      expect(cut.length).toBe(1)
      const wm = h.db.prepare("SELECT chunked_seq FROM ingest_state WHERE session_id = ?").get<{ chunked_seq: number }>(sessionId)
      expect(wm?.chunked_seq).toBe(2)

      const grown = ocMessage({
        role: "assistant",
        id: "a1",
        at: T0,
        parts: [textPart("initial answer", "p1"), textPart("and a later paragraph", "p2")],
      })
      const r = ingest(h.db, sessionId, [userMsg("go", { id: "u1", at: T0 - 10 }), grown], { now: T0 + 50 })
      expect(r.appendedParts).toBe(1)
      expect(r.captured).toBe(0)
      const extra = h.db.prepare("SELECT id, reason, state, start_seq, end_seq FROM chunks WHERE reason = 'appended'").get<{
        id: string
        reason: string
        state: string
        start_seq: number
        end_seq: number
      }>()
      expect(extra?.state).toBe("pending")
      expect(extra?.reason).toBe("appended")
      expect(extra?.start_seq).toBe(extra?.end_seq)
      const parts = h.db.prepare("SELECT id FROM source_parts WHERE message_id = 'a1' ORDER BY ord").all<{ id: string }>()
      expect(parts.map((p) => p.id)).toEqual(["p1", "p2"])
    } finally {
      h.close()
    }
  })

  test("messages missing from a full list are marked removed", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      const messages = [userMsg("a", { id: "u1", at: T0 }), assistantMsg("b", { id: "a1", at: T0 + 1 }), userMsg("c", { id: "u2", at: T0 + 2 })]
      ingest(h.db, sessionId, messages)
      const gone = markRemovedMessages(h.db, sessionId, new Set(["u1", "a1"]))
      expect(gone).toEqual(["u2"])
      const row = h.db.prepare("SELECT status FROM source_messages WHERE id = 'u2'").get<{ status: string }>()
      expect(row?.status).toBe("removed")
      const kept = h.db.prepare("SELECT status FROM source_messages WHERE id = 'u1'").get<{ status: string }>()
      expect(kept?.status).toBe("present")
    } finally {
      h.close()
    }
  })

  test("tool parts are snapshotted once and not duplicated on re-ingest", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      const msg = ocMessage({
        role: "assistant",
        id: "a1",
        at: T0,
        parts: [toolPart("bash", "ok\n", { id: "t1" })],
      })
      ingest(h.db, sessionId, [msg])
      ingest(h.db, sessionId, [msg])
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM source_parts").get<{ n: number }>()!.n).toBe(1)
    } finally {
      h.close()
    }
  })

  test("padded messages record token estimates matching text length", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, [userMsg(textOfTokens(40, "alpha"), { id: "u1" })])
      const row = h.db.prepare("SELECT token_est FROM source_messages WHERE id = 'u1'").get<{ token_est: number }>()
      expect(row?.token_est).toBe(40)
    } finally {
      h.close()
    }
  })
})
