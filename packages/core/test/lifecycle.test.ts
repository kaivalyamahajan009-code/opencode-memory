import { afterAll, describe, expect, test } from "bun:test"
import { CUT, T0, assistantMsg, cleanupAllTempDirs, ingest, openHarness, putObservation, seed, userMsg } from "./helpers"
import { applyRevert, clearRevert, recordForkLineage, sessionLineage } from "../src/lifecycle"
import { approveObservation, getObservation } from "../src/observations"
import { claimChunk, cutChunks, markSucceeded } from "../src/chunks"
import { buildMemoryBlock } from "../src/inject"

afterAll(cleanupAllTempDirs)

describe("revert and fork", () => {
  test("applyRevert hides in-range observations, keeps ones wholly before, treats straddling as reverted", async () => {
    const h = await openHarness()
    try {
      const { sessionId, projectId, workspace } = seed(h.db)
      const messages = [
        userMsg("before one", { id: "u1", at: T0 }),
        assistantMsg("before two", { id: "a1", at: T0 + 1 }),
        userMsg("reverted three", { id: "u2", at: T0 + 2 }),
        assistantMsg("reverted four", { id: "a2", at: T0 + 3 }),
      ]
      ingest(h.db, sessionId, messages)
      const { id: before } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        content: "observation wholly before the revert",
        sources: [{ sessionId, startMessageId: "u1", endMessageId: "a1", startSeq: 1, endSeq: 2, transformVersion: 1 }],
      })
      const { id: inside } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        content: "observation wholly inside the revert",
        sources: [{ sessionId, startMessageId: "u2", endMessageId: "a2", startSeq: 3, endSeq: 4, transformVersion: 1 }],
      })
      const { id: straddle } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        content: "observation straddling the revert",
        sources: [{ sessionId, startMessageId: "a1", endMessageId: "u2", startSeq: 2, endSeq: 3, transformVersion: 1 }],
      })
      const r = applyRevert(h.db, sessionId, "u2", T0 + 10)
      expect(r.reverted).toBe(2)
      expect(getObservation(h.db, before)?.visibility).toBe("visible")
      expect(getObservation(h.db, inside)?.visibility).toBe("reverted")
      expect(getObservation(h.db, straddle)?.visibility).toBe("reverted")
      expect(r.hidden).toBe(2)
    } finally {
      h.close()
    }
  })

  test("straddling succeeded chunk is cancelled, coverage removed, chunked_seq rewound", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, [
        userMsg("one", { id: "u1", at: T0 }),
        assistantMsg("two", { id: "a1", at: T0 + 1 }),
        userMsg("three", { id: "u2", at: T0 + 2 }),
      ])
      cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })
      const claim = claimChunk(h.db, "w1", { leaseMs: 5_000, now: T0 })!
      h.db.tx(() => markSucceeded(h.db, claim, T0 + 1))
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(1)
      const wm = h.db.prepare("SELECT chunked_seq FROM ingest_state WHERE session_id = ?").get<{ chunked_seq: number }>(sessionId)
      expect(wm?.chunked_seq).toBe(3)
      const r = applyRevert(h.db, sessionId, "a1", T0 + 20)
      expect(r.cancelled).toBe(1)
      expect(h.db.prepare("SELECT state FROM chunks WHERE id = ?").get<{ state: string }>(claim.chunk.id)?.state).toBe("cancelled")
      const cov = h.db.prepare("SELECT start_seq, end_seq FROM coverage").get<{ start_seq: number; end_seq: number }>()
      expect(cov).toMatchObject({ start_seq: 1, end_seq: 1 })
      const after = h.db.prepare("SELECT chunked_seq FROM ingest_state WHERE session_id = ?").get<{ chunked_seq: number }>(sessionId)
      expect(after?.chunked_seq).toBe(1)
    } finally {
      h.close()
    }
  })

  test("human-approved observations get a review item instead of being hidden", async () => {
    const h = await openHarness()
    try {
      const { sessionId, projectId, workspace } = seed(h.db)
      ingest(h.db, sessionId, [userMsg("approve me", { id: "u1" }), assistantMsg("ok", { id: "a1", at: T0 + 1 }), userMsg("later", { id: "u2", at: T0 + 2 })])
      const { id } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        status: "pending_review",
        content: "approved personal fact",
        reviewReason: "review",
        targetScope: "user",
        sources: [{ sessionId, startMessageId: "u1", endMessageId: "a1", startSeq: 1, endSeq: 2, transformVersion: 1 }],
      })
      expect(approveObservation(h.db, id, "user")).toBe(true)
      const r = applyRevert(h.db, sessionId, "u1", T0 + 50)
      expect(r.flagged).toBe(1)
      expect(r.hidden).toBe(0)
      expect(getObservation(h.db, id)?.visibility).toBe("visible")
      const review = h.db.prepare("SELECT kind, state FROM review_items WHERE ref_id = ? AND kind = 'source-reverted'").get<{ kind: string; state: string }>(id)
      expect(review).toMatchObject({ kind: "source-reverted", state: "open" })
    } finally {
      h.close()
    }
  })

  test("clearRevert restores present messages", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, [userMsg("one", { id: "u1" }), assistantMsg("two", { id: "a1", at: T0 + 1 }), userMsg("three", { id: "u2", at: T0 + 2 })])
      applyRevert(h.db, sessionId, "a1", T0 + 10)
      expect(h.db.prepare("SELECT status FROM source_messages WHERE id = 'a1'").get<{ status: string }>()?.status).toBe("reverted")
      const r = clearRevert(h.db, sessionId, new Set(["u1", "a1", "u2"]), T0 + 20)
      expect(r.restoredMessages).toBe(2)
      expect(h.db.prepare("SELECT status FROM source_messages WHERE id = 'a1'").get<{ status: string }>()?.status).toBe("present")
      expect(h.db.prepare("SELECT status FROM source_messages WHERE id = 'u2'").get<{ status: string }>()?.status).toBe("present")
      expect(h.db.prepare("SELECT revert_message_id FROM sessions WHERE id = ?").get<{ revert_message_id: string | null }>(sessionId)?.revert_message_id).toBeNull()
    } finally {
      h.close()
    }
  })

  test("clearRevert leaves permanently missing messages removed", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, [userMsg("one", { id: "u1" }), assistantMsg("two", { id: "a1", at: T0 + 1 })])
      applyRevert(h.db, sessionId, "a1", T0 + 10)
      const r = clearRevert(h.db, sessionId, new Set(["u1"]), T0 + 20)
      expect(r.restoredMessages).toBe(0)
      expect(r.removedMessages).toBe(1)
      expect(h.db.prepare("SELECT status FROM source_messages WHERE id = 'a1'").get<{ status: string }>()?.status).toBe("removed")
    } finally {
      h.close()
    }
  })

  test("fork lineage inherits coverage so copied messages are not observed twice", async () => {
    const h = await openHarness()
    try {
      const src = seed(h.db, { sessionId: "ses_src" })
      ingest(h.db, src.sessionId, [userMsg("copied user", { id: "su1" }), assistantMsg("copied assistant", { id: "sa1", at: T0 + 1 })])
      cutChunks(h.db, src.sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })
      const claim = claimChunk(h.db, "w1", { leaseMs: 5_000, now: T0 })!
      h.db.tx(() => markSucceeded(h.db, claim, T0 + 1))
      const dst = seed(h.db, { sessionId: "ses_dst", projectId: src.projectId })
      ingest(h.db, dst.sessionId, [
        userMsg("copied user", { id: "du1", sessionID: dst.sessionId }),
        assistantMsg("copied assistant", { id: "da1", sessionID: dst.sessionId, at: T0 + 1 }),
      ])
      const n = recordForkLineage(h.db, dst.sessionId, {
        sourceSessionID: src.sessionId,
        messages: { su1: "du1", sa1: "da1" },
      })
      expect(n).toBe(2)
      const cov = h.db.prepare("SELECT start_seq, end_seq, inherited_from FROM coverage WHERE session_id = ? ORDER BY start_seq").all<{
        start_seq: number
        end_seq: number
        inherited_from: string | null
      }>(dst.sessionId)
      expect(cov.length).toBe(2)
      expect(cov.every((c) => c.inherited_from)).toBe(true)
      const wm = h.db.prepare("SELECT chunked_seq FROM ingest_state WHERE session_id = ?").get<{ chunked_seq: number }>(dst.sessionId)
      expect(wm?.chunked_seq).toBe(2)
    } finally {
      h.close()
    }
  })

  test("an unresolved exclusive fork boundary resolves when its source message is ingested", async () => {
    const h = await openHarness()
    try {
      const src = seed(h.db, { sessionId: "ses_pending_src" })
      seed(h.db, { sessionId: "ses_pending_fork", projectId: src.projectId })
      recordForkLineage(h.db, "ses_pending_fork", {
        sourceSessionID: src.sessionId,
        boundaryMessageID: "src_boundary",
        messages: {},
      })
      expect(
        h.db
          .prepare("SELECT fork_boundary_seq, fork_boundary_message_id FROM sessions WHERE id = ?")
          .get<{ fork_boundary_seq: number; fork_boundary_message_id: string | null }>("ses_pending_fork"),
      ).toEqual({ fork_boundary_seq: 0, fork_boundary_message_id: "src_boundary" })
      expect(sessionLineage(h.db, "ses_pending_fork")[1]).toEqual({ sessionId: src.sessionId, maxSeq: 0 })

      ingest(h.db, src.sessionId, [
        userMsg("before boundary", { id: "src_before", sessionID: src.sessionId }),
        userMsg("exclusive boundary", { id: "src_boundary", sessionID: src.sessionId, at: T0 + 1 }),
      ])
      expect(
        h.db
          .prepare("SELECT fork_boundary_seq, fork_boundary_message_id FROM sessions WHERE id = ?")
          .get<{ fork_boundary_seq: number; fork_boundary_message_id: string | null }>("ses_pending_fork"),
      ).toEqual({ fork_boundary_seq: 1, fork_boundary_message_id: null })
      expect(sessionLineage(h.db, "ses_pending_fork")[1]).toEqual({ sessionId: src.sessionId, maxSeq: 1 })
    } finally {
      h.close()
    }
  })

  test("an empty-map fork at the first source message keeps an exclusive zero boundary", async () => {
    const h = await openHarness()
    try {
      const src = seed(h.db, { sessionId: "ses_first_src" })
      seed(h.db, { sessionId: "ses_first_fork", projectId: src.projectId })
      recordForkLineage(h.db, "ses_first_fork", {
        sourceSessionID: src.sessionId,
        boundaryMessageID: "src_first",
        messages: {},
      })
      ingest(h.db, src.sessionId, [
        userMsg("exclusive first message", { id: "src_first", sessionID: src.sessionId }),
        userMsg("later source message", { id: "src_later", sessionID: src.sessionId, at: T0 + 1 }),
      ])
      expect(sessionLineage(h.db, "ses_first_fork")[1]).toEqual({ sessionId: src.sessionId, maxSeq: 0 })
    } finally {
      h.close()
    }
  })

  test("fork injection never sees the exclusive boundary or later source messages", async () => {
    const h = await openHarness()
    try {
      const src = seed(h.db, { sessionId: "ses_visible_src" })
      seed(h.db, { sessionId: "ses_visible_fork", projectId: src.projectId })
      recordForkLineage(h.db, "ses_visible_fork", {
        sourceSessionID: src.sessionId,
        boundaryMessageID: "visible_boundary",
        messages: {},
      })
      ingest(h.db, src.sessionId, [
        userMsg("source before", { id: "visible_before", sessionID: src.sessionId }),
        userMsg("source boundary", { id: "visible_boundary", sessionID: src.sessionId, at: T0 + 1 }),
        userMsg("source later", { id: "visible_later", sessionID: src.sessionId, at: T0 + 2 }),
      ])
      const source = (content: string, id: string, seq: number) =>
        putObservation(h.db, {
          workspace: src.workspace,
          projectId: src.projectId,
          sessionId: src.sessionId,
          scopeKind: "session",
          actor: "observer",
          content,
          sources: [{ sessionId: src.sessionId, startMessageId: id, endMessageId: id, startSeq: seq, endSeq: seq, transformVersion: 1 }],
        })
      source("visible note before the fork", "visible_before", 1)
      source("hidden note at the fork boundary", "visible_boundary", 2)
      source("hidden note after the fork boundary", "visible_later", 3)

      const block = buildMemoryBlock(h.db, {
        ctx: { projectId: src.projectId, workspace: src.workspace, sessionId: "ses_visible_fork" },
        domain: "general",
        budget: { profile: 80, workspace: 80, project: 80, session: 400, task: 40, recall: 80 },
      }).block
      expect(block).toContain("visible note before")
      expect(block).not.toContain("hidden note at")
      expect(block).not.toContain("hidden note after")
    } finally {
      h.close()
    }
  })
})
