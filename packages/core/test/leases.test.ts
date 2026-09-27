import { afterAll, describe, expect, test } from "bun:test"
import { CUT, T0, FakeRunner, assistantMsg, cleanupAllTempDirs, ingest, makeAdapter, openEngine, openHarness, seed, textOfTokens, track, userMsg } from "./helpers"
import { StaleLeaseError, assertLease, claimChunk, cutChunks, markSucceeded, releaseOwner } from "../src/chunks"
import { commitObservations } from "../src/observer"

afterAll(cleanupAllTempDirs)

async function pendingChunk() {
  const h = await openHarness()
  const { sessionId, projectId } = seed(h.db)
  ingest(h.db, sessionId, [userMsg("alpha beta gamma", { id: "u1" }), assistantMsg("delta epsilon", { id: "a1", at: T0 + 1 })])
  const ids = cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })
  return { h, sessionId, projectId, chunkId: ids[0] }
}

describe("leases and crash recovery", () => {
  test("owner A claims, expiry lets owner B reclaim", async () => {
    const { h } = await pendingChunk()
    try {
      const a = claimChunk(h.db, "owner-a", { leaseMs: 1_000, now: T0 })
      expect(a?.owner).toBe("owner-a")
      expect(a?.chunk.state).toBe("running")
      expect(a?.version).toBe(1)
      expect(claimChunk(h.db, "owner-b", { leaseMs: 1_000, now: T0 + 500 })).toBeUndefined()

      const b = claimChunk(h.db, "owner-b", { leaseMs: 1_000, now: T0 + 1_001 })
      expect(b?.owner).toBe("owner-b")
      expect(b?.version).toBe(2)
      const row = h.db.prepare("SELECT lease_owner, version, state FROM chunks WHERE id = ?").get<{ lease_owner: string; version: number; state: string }>(a!.chunk.id)
      expect(row).toMatchObject({ lease_owner: "owner-b", version: 2, state: "running" })
    } finally {
      h.close()
    }
  })

  test("committing with a stale lease throws and writes no coverage or observations", async () => {
    const { h, sessionId } = await pendingChunk()
    try {
      const a = claimChunk(h.db, "owner-a", { leaseMs: 1_000, now: T0 })!
      claimChunk(h.db, "owner-b", { leaseMs: 1_000, now: T0 + 2_000 })
      const report = {
        observations: [
          {
            kind: "fact",
            content: "should not persist under a stolen lease",
            eventAt: T0,
            confidence: 0.9,
            evidenceType: "observed",
            priority: "medium",
            scopeHint: "session" as const,
            payload: {},
            start: { ref: "m1", id: "u1", seq: 1, at: T0, role: "user", text: "x", recallOnly: false, partIds: [] },
            end: { ref: "m1", id: "u1", seq: 1, at: T0, role: "user", text: "x", recallOnly: false, partIds: [] },
            hasUserSource: true,
            fromRecall: false,
            partIds: [],
          },
        ],
        dropped: [] as { reason: string }[],
      }
      expect(() => commitObservations(h.db, a, report, T0 + 3_000)).toThrow(StaleLeaseError)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(0)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM observations").get<{ n: number }>()!.n).toBe(0)
      expect(h.db.prepare("SELECT state FROM chunks WHERE session_id = ?").get<{ state: string }>(sessionId)?.state).toBe("running")
    } finally {
      h.close()
    }
  })

  test("assertLease rejects a stale claim object", async () => {
    const { h } = await pendingChunk()
    try {
      const a = claimChunk(h.db, "owner-a", { leaseMs: 500, now: T0 })!
      claimChunk(h.db, "owner-b", { leaseMs: 500, now: T0 + 600 })
      expect(() => assertLease(h.db, a)).toThrow(StaleLeaseError)
    } finally {
      h.close()
    }
  })

  test("releaseOwner returns running chunks to pending", async () => {
    const { h } = await pendingChunk()
    try {
      const a = claimChunk(h.db, "owner-a", { leaseMs: 5_000, now: T0 })!
      expect(releaseOwner(h.db, "owner-a", T0 + 10)).toBe(1)
      const row = h.db.prepare("SELECT state, lease_owner FROM chunks WHERE id = ?").get<{ state: string; lease_owner: string | null }>(a.chunk.id)
      expect(row).toEqual({ state: "pending", lease_owner: null })
      const again = claimChunk(h.db, "owner-b", { leaseMs: 5_000, now: T0 + 20 })
      expect(again?.owner).toBe("owner-b")
    } finally {
      h.close()
    }
  })

  test("successful commit under a live lease writes coverage exactly once", async () => {
    const { h } = await pendingChunk()
    try {
      const a = claimChunk(h.db, "owner-a", { leaseMs: 5_000, now: T0 })!
      h.db.tx(() => markSucceeded(h.db, a, T0 + 1))
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(1)
      expect(h.db.prepare("SELECT state FROM chunks WHERE id = ?").get<{ state: string }>(a.chunk.id)?.state).toBe("succeeded")
    } finally {
      h.close()
    }
  })

  test("engine.recover cuts leftover unchunked content after idle", async () => {
    const runner = new FakeRunner().always({ observations: [] })
    const ctx = await openEngine({ runner })
    try {
      const adapter = makeAdapter(runner, { directory: ctx.dir })
      ctx.engine.register(adapter, T0)
      track(ctx.engine, adapter, { id: "ses_a" }, T0)
      ctx.engine.ingest("ses_a", [userMsg(textOfTokens(20, "leftover"), { id: "u1", at: T0 })], { now: T0 })
      const before = ctx.engine.db.prepare("SELECT chunked_seq, last_seq FROM ingest_state WHERE session_id = 'ses_a'").get<{ chunked_seq: number; last_seq: number }>()
      expect(before?.last_seq).toBe(1)
      expect(before?.chunked_seq).toBe(0)
      const r = ctx.engine.recover(T0 + 60_001)
      expect(r.chunks).toBeGreaterThanOrEqual(1)
      const after = ctx.engine.db.prepare("SELECT chunked_seq FROM ingest_state WHERE session_id = 'ses_a'").get<{ chunked_seq: number }>()
      expect(after?.chunked_seq).toBe(1)
    } finally {
      await ctx.close()
    }
  })
})
