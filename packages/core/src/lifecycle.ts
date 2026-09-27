import type { Database } from "./sqlite"
import { cancelOpenChunks, coveredRanges, contiguousCoverage, isSeqCovered, restoreCoverage, restoreRevertedChunks } from "./chunks"
import { bumpMemoryGeneration, getSources, openReview, recordEvent, upsertSuppression } from "./observations"
import { forkCopyForgotten, seqOfMessage } from "./ingest"

export type RevertResult = { reverted: number; hidden: number; flagged: number; cancelled: number }

/**
 * A revert hides content from the revert point on. An observation stays visible
 * only if at least one source lies wholly outside the reverted range (a range
 * straddling the revert point counts as reverted). Human-approved facts stay and
 * get a review item instead.
 *
 * Chunks: open chunks reaching the revert point are cancelled (reason `revert`).
 * A succeeded chunk straddling the revert point keeps coverage for its surviving
 * prefix only; the chunk remembers the cut (`revert_seq`) so an unrevert that brings
 * back the whole suffix restores its full coverage instead of re-observing it.
 * Succeeded chunks wholly after the revert point keep their coverage (their
 * observations are hidden, not deleted).
 */
export function applyRevert(db: Database, sessionId: string, messageId: string, now = Date.now()): RevertResult {
  return db.tx(() => {
    db.prepare("UPDATE sessions SET revert_message_id = ?, updated_at = ? WHERE id = ?").run(messageId, now, sessionId)
    bumpMemoryGeneration(db)
    const result: RevertResult = { reverted: 0, hidden: 0, flagged: 0, cancelled: 0 }
    const seq = seqOfMessage(db, messageId)
    if (seq === undefined) return result
    result.reverted = db
      .prepare("UPDATE source_messages SET status = 'reverted' WHERE session_id = ? AND seq >= ? AND status = 'present'")
      .run(sessionId, seq).changes
    const affected = db
      .prepare(
        "SELECT id, start_seq, end_seq, state FROM chunks WHERE session_id = ? AND end_seq >= ? AND state IN ('pending','retryable','quarantined','running','succeeded')",
      )
      .all<{ id: string; start_seq: number; end_seq: number; state: string }>(sessionId, seq)
    let lowest = Infinity
    for (const c of affected) {
      if (c.state === "succeeded" && c.start_seq >= seq) continue
      const straddled = c.state === "succeeded" && c.start_seq < seq
      db.prepare(
        "UPDATE chunks SET state = 'cancelled', cancel_reason = 'revert', revert_seq = ?, lease_owner = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ?",
      ).run(straddled ? seq : null, now, c.id)
      db.prepare("DELETE FROM coverage WHERE chunk_id = ?").run(c.id)
      if (straddled) {
        restoreCoverage(db, sessionId, c.start_seq, seq - 1, now, `revert-prefix:${c.id}`)
        lowest = Math.min(lowest, seq - 1)
      } else {
        lowest = Math.min(lowest, Math.min(c.start_seq, seq) - 1)
      }
      result.cancelled++
    }
    if (Number.isFinite(lowest))
      db.prepare("UPDATE ingest_state SET chunked_seq = MIN(chunked_seq, ?), updated_at = ? WHERE session_id = ?").run(lowest, now, sessionId)
    const candidates = db
      .prepare(
        `SELECT DISTINCT o.id FROM observations o JOIN observation_sources s ON s.observation_id = o.id
         WHERE s.session_id = ? AND s.end_seq >= ? AND o.visibility = 'visible' AND o.status != 'forgotten'`,
      )
      .all<{ id: string }>(sessionId, seq)
    for (const { id } of candidates) {
      const outside = db
        .prepare(
          `SELECT COUNT(*) AS n FROM observation_sources s
           WHERE s.observation_id = ?
             AND ((s.session_id = ? AND s.end_seq < ?)
               OR (s.session_id != ? AND NOT EXISTS (
                 SELECT 1 FROM source_messages m WHERE m.session_id = s.session_id AND m.seq BETWEEN s.start_seq AND s.end_seq AND m.status != 'present')))`,
        )
        .get<{ n: number }>(id, sessionId, seq, sessionId)!.n
      if (outside > 0) continue
      const approved = db.prepare("SELECT 1 FROM observation_events WHERE observation_id = ? AND type = 'approved' AND actor = 'user'").get(id)
      if (approved) {
        openReview(db, "source-reverted", id, "the conversation this approved memory came from was reverted", { sessionId, messageId }, now)
        result.flagged++
        continue
      }
      db.prepare("UPDATE observations SET visibility = 'reverted', updated_at = ? WHERE id = ?").run(now, id)
      recordEvent(db, id, "hidden", "system", { reason: "revert", sessionId, messageId }, now)
      result.hidden++
    }
    return result
  })
}

/**
 * Clearing a revert restores only what still exists in OpenCode. Messages that
 * were permanently removed stay removed and their observations stay hidden.
 * Coverage comes back for straddling chunks whose whole suffix returned and for
 * the sources of unhidden observations; only still-uncovered messages are re-cut.
 */
export function clearRevert(db: Database, sessionId: string, presentIds: Set<string>, now = Date.now()) {
  return db.tx(() => {
    db.prepare("UPDATE sessions SET revert_message_id = NULL, updated_at = ? WHERE id = ?").run(now, sessionId)
    bumpMemoryGeneration(db)
    const reverted = db
      .prepare("SELECT id, seq FROM source_messages WHERE session_id = ? AND status = 'reverted' ORDER BY seq")
      .all<{ id: string; seq: number }>(sessionId)
    const restored: number[] = []
    for (const m of reverted) {
      const back = presentIds.has(m.id)
      db.prepare("UPDATE source_messages SET status = ? WHERE id = ?").run(back ? "present" : "removed", m.id)
      if (back) restored.push(m.seq)
    }
    restoreRevertedChunks(db, sessionId, now)
    const hidden = db
      .prepare(
        `SELECT DISTINCT o.id FROM observations o JOIN observation_sources s ON s.observation_id = o.id
         WHERE s.session_id = ? AND o.visibility = 'reverted'`,
      )
      .all<{ id: string }>(sessionId)
    let unhidden = 0
    for (const { id } of hidden) {
      const missing = db
        .prepare(
          `SELECT COUNT(*) AS n FROM observation_sources s JOIN source_messages m ON m.session_id = s.session_id AND m.seq BETWEEN s.start_seq AND s.end_seq
           WHERE s.observation_id = ? AND m.status != 'present'`,
        )
        .get<{ n: number }>(id)!.n
      if (missing) continue
      db.prepare("UPDATE observations SET visibility = 'visible', updated_at = ? WHERE id = ?").run(now, id)
      recordEvent(db, id, "restored", "system", { reason: "revert cleared", sessionId }, now)
      for (const s of getSources(db, id)) {
        if (s.session_id !== sessionId) continue
        restoreCoverage(db, sessionId, s.start_seq, s.end_seq, now, `unhide:${id}`)
      }
      unhidden++
    }
    const ranges = coveredRanges(db, sessionId)
    const uncovered = restored.filter((s) => !isSeqCovered(ranges, s))
    if (uncovered.length)
      db.prepare("UPDATE ingest_state SET chunked_seq = MIN(chunked_seq, ?), updated_at = ? WHERE session_id = ?").run(uncovered[0] - 1, now, sessionId)
    else {
      const covered = contiguousCoverage(db, sessionId)
      if (covered > 0)
        db.prepare("UPDATE ingest_state SET chunked_seq = MAX(chunked_seq, ?), updated_at = ? WHERE session_id = ?").run(covered, now, sessionId)
    }
    return { restoredMessages: restored.length, removedMessages: reverted.length - restored.length, unhidden }
  })
}

export type ForkLineage = {
  sourceSessionID: string
  boundaryMessageID?: string
  messages: Record<string, string>
  parts?: Record<string, string>
}

/** Persist the lineage written by the fork patch (old -> new message/part identity). */
export function recordForkLineage(db: Database, targetSessionId: string, lineage: ForkLineage, now = Date.now()) {
  db.tx(() => {
    const ins = db.prepare("INSERT OR IGNORE INTO fork_map(target_session, source_session, source_id, target_id, kind) VALUES (?,?,?,?,?)")
    for (const [from, to] of Object.entries(lineage.messages ?? {})) ins.run(targetSessionId, lineage.sourceSessionID, from, to, "message")
    for (const [from, to] of Object.entries(lineage.parts ?? {})) ins.run(targetSessionId, lineage.sourceSessionID, from, to, "part")
    const exclusive = lineage.boundaryMessageID
      ? db
          .prepare("SELECT seq FROM source_messages WHERE session_id = ? AND id = ?")
          .get<{ seq: number }>(lineage.sourceSessionID, lineage.boundaryMessageID)?.seq
      : undefined
    const unresolved = lineage.boundaryMessageID && exclusive === undefined ? lineage.boundaryMessageID : null
    const boundary =
      lineage.boundaryMessageID !== undefined
        ? exclusive === undefined
          ? 0
          : exclusive - 1
        : (db
            .prepare(`SELECT MAX(m.seq) AS s FROM fork_map f JOIN source_messages m ON m.id = f.source_id WHERE f.target_session = ? AND f.kind = 'message'`)
            .get<{ s: number | null }>(targetSessionId)?.s ?? null)
    db.prepare(
      "UPDATE sessions SET fork_source = ?, fork_boundary_seq = ?, fork_boundary_message_id = ?, updated_at = ? WHERE id = ?",
    ).run(lineage.sourceSessionID, boundary, unresolved, now, targetSessionId)
    bumpMemoryGeneration(db)
    purgeForgottenCopies(db, targetSessionId, now)
  })
  return applyForkInheritance(db, targetSessionId, now)
}

/** Copies ingested before their lineage was recorded: purge (and suppress) the ones descending from forgotten content. */
function purgeForgottenCopies(db: Database, targetSessionId: string, now: number) {
  const forgotten = forkCopyForgotten(db, targetSessionId)
  if (!forgotten) return
  const rows = db
    .prepare("SELECT p.id, p.message_id, p.hash, m.seq FROM source_parts p JOIN source_messages m ON m.id = p.message_id WHERE p.session_id = ? AND p.suppressed = 0")
    .all<{ id: string; message_id: string; hash: string; seq: number }>(targetSessionId)
  for (const r of rows) {
    if (!forgotten(r.message_id, r.id, r.hash)) continue
    db.prepare("UPDATE source_parts SET text = '[forgotten]', suppressed = 1, redactions = 0 WHERE id = ?").run(r.id)
    upsertSuppression(db, { kind: "part", value: r.id, reason: "fork_of_forgotten", createdAt: now })
    cancelOpenChunks(db, targetSessionId, { reason: "forget", ranges: [[r.seq, r.seq]], now })
  }
}

/** Copy coverage for forked messages whose source was already observed, so they are not observed twice. */
export function applyForkInheritance(db: Database, targetSessionId: string, now = Date.now()): number {
  return db.tx(() => {
    const rows = db
      .prepare(
        `SELECT t.seq AS target_seq, s.seq AS source_seq, s.session_id AS source_session
         FROM fork_map f JOIN source_messages t ON t.id = f.target_id JOIN source_messages s ON s.id = f.source_id
         WHERE f.target_session = ? AND f.kind = 'message' ORDER BY t.seq`,
      )
      .all<{ target_seq: number; source_seq: number; source_session: string }>(targetSessionId)
    if (!rows.length) return 0
    const sourceCoverage = db
      .prepare("SELECT chunk_id, start_seq, end_seq FROM coverage WHERE session_id = ?")
      .all<{ chunk_id: string; start_seq: number; end_seq: number }>(rows[0].source_session)
    let n = 0
    for (const r of rows) {
      const cov = sourceCoverage.find((c) => r.source_seq >= c.start_seq && r.source_seq <= c.end_seq)
      if (!cov) continue
      n += db
        .prepare("INSERT OR IGNORE INTO coverage(chunk_id, session_id, start_seq, end_seq, inherited_from, created_at) VALUES (?,?,?,?,?,?)")
        .run(`inh:${targetSessionId}:${r.target_seq}`, targetSessionId, r.target_seq, r.target_seq, cov.chunk_id, now).changes
    }
    const contiguous = contiguousCoverage(db, targetSessionId)
    if (contiguous > 0)
      db.prepare("UPDATE ingest_state SET chunked_seq = MAX(chunked_seq, ?), updated_at = ? WHERE session_id = ?").run(contiguous, now, targetSessionId)
    return n
  })
}

/** Session ancestry for session-scoped reads: the session itself plus fork sources up to their boundaries. */
export function sessionLineage(db: Database, sessionId: string): { sessionId: string; maxSeq: number | null }[] {
  const out: { sessionId: string; maxSeq: number | null }[] = [{ sessionId, maxSeq: null }]
  const q = db.prepare("SELECT fork_source, fork_boundary_seq FROM sessions WHERE id = ?")
  let cur = q.get<{ fork_source: string | null; fork_boundary_seq: number | null }>(sessionId)
  const seen = new Set([sessionId])
  while (cur?.fork_source && !seen.has(cur.fork_source)) {
    out.push({ sessionId: cur.fork_source, maxSeq: cur.fork_boundary_seq })
    seen.add(cur.fork_source)
    cur = q.get<{ fork_source: string | null; fork_boundary_seq: number | null }>(cur.fork_source)
  }
  return out
}

/** Native OpenCode deletion keeps retained snapshots and memories; only the session row is marked. */
export function markSessionDeleted(db: Database, sessionId: string, now = Date.now()) {
  db.prepare("UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, sessionId)
}
