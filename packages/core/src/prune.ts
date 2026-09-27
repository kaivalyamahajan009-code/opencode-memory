import type { Database } from "./sqlite"
import { contiguousCoverage } from "./chunks"
import { latestContextSnapshot } from "./inject"
import { safeJson } from "./util"

export type PrunableMessage = { info: { id: string; role: string; sessionID?: string }; parts: unknown[] }

/**
 * Decide which leading messages can be dropped from the model context:
 * - fully inside the contiguous successfully-observed prefix (failed/quarantined ranges never qualify),
 * - older than the last `keepRecentTurns` user turns, cut at a user-turn boundary,
 * - every observation sourced from the dropped range is present in the latest injected block.
 */
export function prunableMessageIds(db: Database, sessionId: string, messages: PrunableMessage[], keepRecentTurns: number): Set<string> {
  const out = new Set<string>()
  const covered = contiguousCoverage(db, sessionId)
  if (!covered) return out
  const userIdx = messages.map((m, i) => (m.info.role === "user" ? i : -1)).filter((i) => i >= 0)
  if (userIdx.length <= keepRecentTurns) return out
  const boundary = userIdx[userIdx.length - keepRecentTurns]
  const snapshot = latestContextSnapshot(db, sessionId)
  const injected = new Set(safeJson<string[]>(snapshot?.observation_ids, []))
  const seqOf = db.prepare("SELECT seq FROM source_messages WHERE id = ? AND session_id = ?")
  let cut = 0
  for (let i = 0; i < boundary; i++) {
    const seq = seqOf.get<{ seq: number }>(messages[i].info.id, sessionId)?.seq
    if (seq === undefined || seq > covered) break
    if (messages[i + 1]?.info.role === "user" || i + 1 === boundary) cut = i + 1
  }
  if (!cut) return out
  const ids = messages.slice(0, cut).map((m) => m.info.id)
  const seqs = db
    .prepare(`SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM source_messages WHERE id IN (${ids.map(() => "?").join(",")})`)
    .get<{ lo: number; hi: number }>(...ids)!
  const needed = db
    .prepare(
      `SELECT DISTINCT o.id FROM observations o JOIN observation_sources s ON s.observation_id = o.id
       WHERE s.session_id = ? AND s.start_seq <= ? AND s.end_seq >= ? AND o.status = 'active' AND o.visibility = 'visible'`,
    )
    .all<{ id: string }>(sessionId, seqs.hi, seqs.lo)
  if (needed.some((n) => !injected.has(n.id))) return out
  for (const id of ids) out.add(id)
  return out
}
