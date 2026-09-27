import type { Database } from "./sqlite"
import { deterministicId, startOfLocalDay } from "./util"

/** cancelled: the range was reverted, excluded, forgotten or deleted before observation; it never produces coverage. */
export type ChunkState = "pending" | "running" | "succeeded" | "retryable" | "quarantined" | "split" | "cancelled"

/**
 * Why a chunk was cancelled. Only `revert` chunks are revived by a re-cut of the same
 * range, and `exclude` chunks only when the session is un-excluded. `forget` and
 * `other` (including NULL rows written by older code) are never revived.
 */
export type CancelReason = "revert" | "exclude" | "forget" | "other"

export type ChunkRow = {
  id: string
  session_id: string
  project_id: string
  start_seq: number
  end_seq: number
  parent_id: string | null
  token_est: number
  state: ChunkState
  attempts: number
  lease_owner: string | null
  lease_expires_at: number | null
  version: number
  error: string | null
  error_class: string | null
  next_attempt_at: number | null
  reason: string | null
  part_ids: string | null
  cancel_reason: CancelReason | null
  revert_seq: number | null
  created_at: number
  updated_at: number
}

export type CutReason = "buffer" | "idle" | "age" | "explicit" | "recovery"
export type BufferActivationReason = "activation" | "idle" | "age" | "explicit" | "recovery" | "manual"

export type CutOptions = {
  bufferTokens: number
  maxChunkTokens: number
  minFlushTokens: number
  now?: number
}

export type ObservationBacklog = {
  queuedTokens: number
  tailTokens: number
  totalTokens: number
}

type MsgTok = { seq: number; token_est: number }

export type QueueChunkInput = {
  sessionId: string
  projectId: string
  startSeq: number
  endSeq: number
  tokenEst: number
  reason: string
  now: number
  parentId?: string | null
  partIds?: string[]
  idSalt?: string
  /** Cancel reasons that may be revived by this insert (default: revert only). */
  revive?: CancelReason[]
}

/**
 * Insert a pending chunk, or revive a revert-cancelled row with the same deterministic
 * id so an unrevert that re-cuts the same range is not silently ignored. Rows cancelled
 * for any other reason (forget, exclude, delete) stay cancelled.
 */
export function queueChunk(db: Database, input: QueueChunkInput): string {
  const id = deterministicId("ch", input.sessionId, input.startSeq, input.endSeq, input.parentId ?? "", input.idSalt ?? "")
  const partJson = input.partIds?.length ? JSON.stringify(input.partIds) : null
  const existing = db
    .prepare("SELECT state, cancel_reason FROM chunks WHERE id = ?")
    .get<{ state: string; cancel_reason: string | null }>(id)
  if (existing) {
    const revivable = new Set<string>(input.revive ?? ["revert"])
    if (existing.state === "cancelled" && existing.cancel_reason && revivable.has(existing.cancel_reason)) {
      db.prepare(
        `UPDATE chunks SET state = 'pending', attempts = 0, lease_owner = NULL, lease_expires_at = NULL,
           error = NULL, error_class = NULL, next_attempt_at = NULL, version = version + 1, token_est = ?,
           reason = ?, part_ids = ?, parent_id = ?, project_id = ?, cancel_reason = NULL, revert_seq = NULL, updated_at = ? WHERE id = ?`,
      ).run(input.tokenEst, input.reason, partJson, input.parentId ?? null, input.projectId, input.now, id)
    }
    return id
  }
  db.prepare(
    `INSERT INTO chunks(id, session_id, project_id, start_seq, end_seq, parent_id, token_est, state, reason, part_ids, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?)`,
  ).run(
    id,
    input.sessionId,
    input.projectId,
    input.startSeq,
    input.endSeq,
    input.parentId ?? null,
    input.tokenEst,
    input.reason,
    partJson,
    input.now,
    input.now,
  )
  return id
}

function insertChunk(db: Database, sessionId: string, projectId: string, msgs: MsgTok[], reason: string, now: number, parent?: string) {
  const start = msgs[0].seq
  const end = msgs[msgs.length - 1].seq
  const tokens = msgs.reduce((n, m) => n + m.token_est, 0)
  return queueChunk(db, {
    sessionId,
    projectId,
    startSeq: start,
    endSeq: end,
    tokenEst: tokens,
    reason,
    now,
    parentId: parent ?? null,
  })
}

/** Split an ordered message list into groups no larger than maxTokens (a single oversized message forms its own group). */
function group(msgs: MsgTok[], maxTokens: number): MsgTok[][] {
  const groups: MsgTok[][] = []
  let cur: MsgTok[] = []
  let tok = 0
  for (const m of msgs) {
    if (cur.length && tok + m.token_est > maxTokens) {
      groups.push(cur)
      cur = []
      tok = 0
    }
    cur.push(m)
    tok += m.token_est
  }
  if (cur.length) groups.push(cur)
  return groups
}

type CutMsg = MsgTok & { covered: boolean }

/** Uncovered runs of a message list: a covered message ends the current run and is dropped. */
function uncoveredRuns(msgs: CutMsg[]): MsgTok[][] {
  const runs: MsgTok[][] = []
  let cur: MsgTok[] = []
  for (const m of msgs) {
    if (m.covered) {
      if (cur.length) runs.push(cur)
      cur = []
      continue
    }
    cur.push({ seq: m.seq, token_est: m.token_est })
  }
  if (cur.length) runs.push(cur)
  return runs
}

/**
 * Cut chunks from content past the chunking watermark. Messages that already have
 * coverage (restored after an unrevert, inherited from a fork) are skipped, so only
 * uncovered sub-ranges are observed.
 * - buffer: only full chunks (>= bufferTokens), leaving the partial tail.
 * - idle: flush everything once minFlushTokens is met.
 * - age/explicit/recovery: flush everything (age and recovery ignore minFlushTokens).
 */
export function cutChunks(db: Database, sessionId: string, reason: CutReason, opts: CutOptions): string[] {
  const now = opts.now ?? Date.now()
  return db.tx(() => {
    const session = db
      .prepare("SELECT project_id, excluded, paused, internal, deleted_at FROM sessions WHERE id = ?")
      .get<{ project_id: string; excluded: number; paused: number; internal: number; deleted_at: number | null }>(sessionId)
    const state = db
      .prepare("SELECT chunked_seq, last_seq FROM ingest_state WHERE session_id = ?")
      .get<{ chunked_seq: number; last_seq: number }>(sessionId)
    if (!session || !state) return []
    if (session.excluded || session.paused || session.internal || session.deleted_at) return []
    const ranges = coveredRanges(db, sessionId)
    const msgs: CutMsg[] = db
      .prepare(
        "SELECT seq, token_est FROM source_messages WHERE session_id = ? AND seq > ? AND seq <= ? AND status != 'reverted' ORDER BY seq",
      )
      .all<MsgTok>(sessionId, state.chunked_seq, state.last_seq)
      .map((m) => ({ ...m, covered: isSeqCovered(ranges, m.seq) }))
    if (!msgs.length) return []
    const fresh = msgs.filter((m) => !m.covered)
    const total = fresh.reduce((n, m) => n + m.token_est, 0)
    const ids: string[] = []
    const emit = (list: CutMsg[]) => {
      for (const run of uncoveredRuns(list))
        for (const g of group(run, opts.maxChunkTokens)) ids.push(insertChunk(db, sessionId, session.project_id, g, reason, now))
    }
    let upto = state.chunked_seq
    if (reason === "buffer") {
      let cur: CutMsg[] = []
      let tok = 0
      for (const m of msgs) {
        cur.push(m)
        if (!m.covered) tok += m.token_est
        if (tok >= opts.bufferTokens) {
          emit(cur)
          upto = m.seq
          cur = []
          tok = 0
        }
      }
      if (cur.length && cur.every((m) => m.covered)) upto = cur[cur.length - 1].seq
    } else {
      if (reason === "idle" && fresh.length && total < opts.minFlushTokens) return []
      emit(msgs)
      upto = msgs[msgs.length - 1].seq
    }
    if (upto > state.chunked_seq)
      db.prepare("UPDATE ingest_state SET chunked_seq = ?, updated_at = ? WHERE session_id = ?").run(upto, now, sessionId)
    return ids
  })
}

/**
 * Tokens which still need observation. Open chunks are before the chunking watermark;
 * the tail is after it and excludes ranges already covered through fork/revert recovery.
 */
export function observationBacklog(db: Database, sessionId: string): ObservationBacklog {
  const queuedTokens = db
    .prepare(
      `SELECT COALESCE(SUM(token_est),0) AS tokens FROM chunks
       WHERE session_id = ? AND state IN ('pending','retryable','running')`,
    )
    .get<{ tokens: number }>(sessionId)?.tokens ?? 0
  const tailTokens = db
    .prepare(
      `SELECT COALESCE(SUM(m.token_est),0) AS tokens
       FROM source_messages m JOIN ingest_state i ON i.session_id = m.session_id
       WHERE m.session_id = ? AND m.seq > i.chunked_seq AND m.status != 'reverted'
       AND NOT EXISTS (
         SELECT 1 FROM coverage c
         WHERE c.session_id = m.session_id AND m.seq BETWEEN c.start_seq AND c.end_seq
       )`,
    )
    .get<{ tokens: number }>(sessionId)?.tokens ?? 0
  return { queuedTokens, tailTokens, totalTokens: queuedTokens + tailTokens }
}

/**
 * Make fixed buffer chunks claimable by automatic drains. The marker is kept in the
 * existing durable reason column so an activated batch remains ready across restarts.
 */
export function activateBufferChunks(
  db: Database,
  sessionId: string,
  reason: BufferActivationReason,
  now = Date.now(),
): number {
  return db
    .prepare(
      `UPDATE chunks SET reason = ?, updated_at = ?
       WHERE session_id = ? AND reason = 'buffer' AND state IN ('pending','retryable','running')`,
    )
    .run(`buffer:${reason}`, now, sessionId).changes
}

export type Claim = { chunk: ChunkRow; owner: string; version: number }

/** Transactional claim with lease; also reclaims expired leases from crashed owners. */
export function claimChunk(
  db: Database,
  owner: string,
  opts: { projectIds?: string[]; leaseMs: number; now?: number; includeInactiveBuffer?: boolean },
): Claim | undefined {
  const now = opts.now ?? Date.now()
  return db.tx(() => {
    const filter = opts.projectIds?.length ? `AND c.project_id IN (${opts.projectIds.map(() => "?").join(",")})` : ""
    const activation = opts.includeInactiveBuffer === false ? "AND COALESCE(c.reason,'') != 'buffer'" : ""
    const row = db
      .prepare(
        `SELECT c.* FROM chunks c JOIN sessions s ON s.id = c.session_id
         WHERE ((c.state IN ('pending','retryable') AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= ?))
            OR (c.state = 'running' AND c.lease_expires_at < ?))
         AND s.excluded = 0 AND s.paused = 0 AND s.internal = 0 AND s.deleted_at IS NULL
         ${activation}
         ${filter}
         ORDER BY c.created_at, c.start_seq LIMIT 1`,
      )
      .get<ChunkRow>(now, now, ...(opts.projectIds ?? []))
    if (!row) return undefined
    const version = row.version + 1
    db.prepare(
      "UPDATE chunks SET state = 'running', lease_owner = ?, lease_expires_at = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
    ).run(owner, now + opts.leaseMs, version, now, row.id, row.version)
    return { chunk: { ...row, state: "running", lease_owner: owner, version }, owner, version }
  })
}

export class StaleLeaseError extends Error {
  constructor(id: string) {
    super(`lease lost for chunk ${id}`)
  }
}

/** Must be called inside a transaction. Throws if another worker took over. */
export function assertLease(db: Database, claim: Claim): void {
  const row = db
    .prepare("SELECT state, lease_owner, version FROM chunks WHERE id = ?")
    .get<{ state: string; lease_owner: string | null; version: number }>(claim.chunk.id)
  if (!row || row.state !== "running" || row.lease_owner !== claim.owner || row.version !== claim.version)
    throw new StaleLeaseError(claim.chunk.id)
}

export function renewLease(db: Database, claim: Claim, leaseMs: number, now = Date.now()): boolean {
  const r = db
    .prepare(
      "UPDATE chunks SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND version = ? AND state = 'running'",
    )
    .run(now + leaseMs, claim.chunk.id, claim.owner, claim.version)
  return r.changes > 0
}

/** Inside the success transaction: record exact coverage and mark succeeded. A success also clears the auth backoff. */
export function markSucceeded(db: Database, claim: Claim, now = Date.now()): void {
  assertLease(db, claim)
  db.prepare(
    "INSERT OR IGNORE INTO coverage(chunk_id, session_id, start_seq, end_seq, created_at) VALUES (?,?,?,?,?)",
  ).run(claim.chunk.id, claim.chunk.session_id, claim.chunk.start_seq, claim.chunk.end_seq, now)
  db.prepare(
    "UPDATE chunks SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, error = NULL, error_class = NULL, updated_at = ? WHERE id = ?",
  ).run(now, claim.chunk.id)
  db.prepare("DELETE FROM runtime_state WHERE key = 'auth_strikes'").run()
}

export type FailureClass = "oversize" | "invalid_output" | "rate_limit" | "transient" | "auth" | "cost_limit" | "aborted"

export type FailureOutcome = "retry" | "split" | "quarantined" | "paused" | "stale"

/** A user's pause (no reason row counts as manual) that is open-ended or ends after `until`. */
function manualPauseOutlasts(db: Database, until: number, now: number): boolean {
  const paused = db.prepare("SELECT value, until FROM runtime_state WHERE key = 'paused'").get<{ value: string; until: number | null }>()
  if (paused?.value !== "1" || (paused.until != null && paused.until <= now)) return false
  const reason = db.prepare("SELECT value, until FROM runtime_state WHERE key = 'paused_reason'").get<{ value: string; until: number | null }>()
  const live = reason && (reason.until == null || reason.until > now) ? reason.value : "manual"
  return live === "manual" && (paused.until == null || paused.until >= until)
}

/** Classify a failure and move the chunk to the right state. Never advances coverage. */
export function failChunk(
  db: Database,
  claim: Claim,
  err: { cls: FailureClass; message: string; retryAfterMs?: number },
  opts: { maxAttempts: number; now?: number },
): FailureOutcome {
  const now = opts.now ?? Date.now()
  return db.tx(() => {
    try {
      assertLease(db, claim)
    } catch {
      return "stale"
    }
    const c = claim.chunk
    const release = (state: ChunkState, attempts: number, next: number | null, reason?: string | null) =>
      db
        .prepare(
          "UPDATE chunks SET state = ?, attempts = ?, lease_owner = NULL, lease_expires_at = NULL, error = ?, error_class = ?, next_attempt_at = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ?",
        )
        .run(state, attempts, err.message.slice(0, 2000), err.cls, next, reason ?? null, now, c.id)

    if (err.cls === "auth") {
      const strikesRow = db.prepare("SELECT value FROM runtime_state WHERE key = 'auth_strikes'").get<{ value: string }>()
      const strikes = Math.max(0, Number(strikesRow?.value ?? 0) || 0)
      const backoff = err.retryAfterMs ?? Math.min(24 * 60 * 60_000, 30 * 60_000 * 2 ** Math.min(strikes, 6))
      const until = now + backoff
      if (!manualPauseOutlasts(db, until, now)) {
        db.prepare("INSERT OR REPLACE INTO runtime_state(key, value, until, updated_at) VALUES ('paused', '1', ?, ?)").run(until, now)
        db.prepare("INSERT OR REPLACE INTO runtime_state(key, value, until, updated_at) VALUES ('paused_reason', 'auth', ?, ?)").run(until, now)
      }
      db.prepare("INSERT OR REPLACE INTO runtime_state(key, value, until, updated_at) VALUES ('auth_strikes', ?, NULL, ?)").run(String(strikes + 1), now)
      release("pending", c.attempts, until)
      return "paused"
    }
    if (err.cls === "cost_limit") {
      const next = err.retryAfterMs ? now + err.retryAfterMs : startOfLocalDay(now) + 86_400_000
      release("pending", c.attempts, next)
      return "paused"
    }
    if (err.cls === "aborted") {
      release("pending", c.attempts, err.retryAfterMs ? now + err.retryAfterMs : null)
      return "paused"
    }
    if (err.cls === "rate_limit") {
      const backoff = err.retryAfterMs ?? Math.min(15 * 60_000, 15_000 * 2 ** Math.min(c.attempts, 6))
      release("retryable", c.attempts, now + backoff)
      return "retry"
    }
    const attempts = c.attempts + 1
    if (err.cls === "transient") {
      if (attempts < opts.maxAttempts * 2) {
        const backoff = err.retryAfterMs ?? Math.min(15 * 60_000, 15_000 * 2 ** Math.min(attempts, 6))
        release("retryable", attempts, now + backoff)
        return "retry"
      }
      release("quarantined", attempts, null, "transient_exhausted")
      return "quarantined"
    }
    const splittable = c.end_seq > c.start_seq
    if (err.cls === "oversize" && splittable) {
      splitChunk(db, c, now)
      return "split"
    }
    if (attempts < opts.maxAttempts) {
      release("retryable", attempts, now + 5_000 * attempts)
      return "retry"
    }
    if (splittable) {
      splitChunk(db, c, now)
      return "split"
    }
    release("quarantined", attempts, null)
    return "quarantined"
  })
}

/** Children cover the entire parent range, split at a message boundary. */
function splitChunk(db: Database, c: ChunkRow, now: number): void {
  const msgs = db
    .prepare("SELECT seq, token_est FROM source_messages WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq")
    .all<MsgTok>(c.session_id, c.start_seq, c.end_seq)
  const total = msgs.reduce((n, m) => n + m.token_est, 0)
  let acc = 0
  let cut = 1
  for (let i = 0; i < msgs.length - 1; i++) {
    acc += msgs[i].token_est
    cut = i + 1
    if (acc >= total / 2) break
  }
  const left = msgs.slice(0, cut)
  const right = msgs.slice(cut)
  db.prepare(
    "UPDATE chunks SET state = 'split', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now, c.id)
  if (left.length) insertChunk(db, c.session_id, c.project_id, left, "split", now, c.id)
  if (right.length) insertChunk(db, c.session_id, c.project_id, right, "split", now, c.id)
}

export function retryChunk(db: Database, id: string, now = Date.now()): boolean {
  const r = db
    .prepare(
      "UPDATE chunks SET state = 'pending', attempts = 0, next_attempt_at = NULL, error = NULL, error_class = NULL, updated_at = ? WHERE id = ? AND state IN ('quarantined','retryable')",
    )
    .run(now, id)
  return r.changes > 0
}

export function retryAllQuarantined(db: Database, sessionId?: string, now = Date.now()): number {
  const r = sessionId
    ? db
        .prepare(
          "UPDATE chunks SET state = 'pending', attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE state = 'quarantined' AND session_id = ?",
        )
        .run(now, sessionId)
    : db
        .prepare("UPDATE chunks SET state = 'pending', attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE state = 'quarantined'")
        .run(now)
  return r.changes
}

export type CancelOptions = {
  reason: CancelReason
  /** Only chunks overlapping one of these inclusive seq ranges; all open chunks when omitted. */
  ranges?: [number, number][]
  now?: number
}

/**
 * Cancel open chunks for a session and bump their version so in-flight leases fail.
 * "Open" means pending, retryable, running AND quarantined: a quarantined chunk would
 * otherwise come back through "retry quarantined" and observe the cancelled range.
 * Revert cancellation (lifecycle.applyRevert) uses the same set of states.
 */
export function cancelOpenChunks(db: Database, sessionId: string, opts: CancelOptions = { reason: "other" }): number {
  const now = opts.now ?? Date.now()
  const base = `UPDATE chunks SET state = 'cancelled', cancel_reason = ?, lease_owner = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?
    WHERE session_id = ? AND state IN ('pending','retryable','quarantined','running')`
  if (!opts.ranges) return db.prepare(base).run(opts.reason, now, sessionId).changes
  let n = 0
  for (const [start, end] of opts.ranges) {
    n += db.prepare(`${base} AND start_seq <= ? AND end_seq >= ?`).run(opts.reason, now, sessionId, end, start).changes
  }
  return n
}

/**
 * Un-exclude: revive chunks cancelled by the exclusion so the range is not left as a
 * permanent gap. Chunks overlapping the sources of a forgotten observation, and every
 * chunk of a forgotten session, stay cancelled.
 */
export function reviveExcludedChunks(db: Database, sessionId: string, now = Date.now()): number {
  return db.tx(() => {
    if (db.prepare("SELECT 1 FROM suppressions WHERE kind = 'session' AND value = ?").get(sessionId)) return 0
    const rows = db
      .prepare("SELECT id, start_seq, end_seq FROM chunks WHERE session_id = ? AND state = 'cancelled' AND cancel_reason = 'exclude'")
      .all<{ id: string; start_seq: number; end_seq: number }>(sessionId)
    const forgottenOverlap = db.prepare(
      `SELECT 1 FROM observation_sources s JOIN observations o ON o.id = s.observation_id
       WHERE s.session_id = ? AND o.status = 'forgotten' AND s.start_seq <= ? AND s.end_seq >= ? LIMIT 1`,
    )
    let n = 0
    for (const r of rows) {
      if (forgottenOverlap.get(sessionId, r.end_seq, r.start_seq)) {
        db.prepare("UPDATE chunks SET cancel_reason = 'forget', updated_at = ? WHERE id = ?").run(now, r.id)
        continue
      }
      n += db
        .prepare(
          `UPDATE chunks SET state = 'pending', cancel_reason = NULL, attempts = 0, lease_owner = NULL, lease_expires_at = NULL,
             error = NULL, error_class = NULL, next_attempt_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(now, r.id).changes
    }
    return n
  })
}

/**
 * Unrevert: a succeeded chunk that a revert cut at `revert_seq` gets its full coverage
 * back (and is succeeded again) once every message of the reverted suffix is present,
 * so the suffix is not observed a second time. Returns the restored chunk ids.
 */
export function restoreRevertedChunks(db: Database, sessionId: string, now = Date.now()): string[] {
  const rows = db
    .prepare(
      "SELECT id, start_seq, end_seq, revert_seq FROM chunks WHERE session_id = ? AND state = 'cancelled' AND cancel_reason = 'revert' AND revert_seq IS NOT NULL",
    )
    .all<{ id: string; start_seq: number; end_seq: number; revert_seq: number }>(sessionId)
  const restored: string[] = []
  for (const c of rows) {
    const missing = db
      .prepare("SELECT COUNT(*) AS n FROM source_messages WHERE session_id = ? AND seq BETWEEN ? AND ? AND status != 'present'")
      .get<{ n: number }>(sessionId, c.revert_seq, c.end_seq)!.n
    const expected = c.end_seq - c.revert_seq + 1
    const present = db
      .prepare("SELECT COUNT(*) AS n FROM source_messages WHERE session_id = ? AND seq BETWEEN ? AND ?")
      .get<{ n: number }>(sessionId, c.revert_seq, c.end_seq)!.n
    if (missing || present !== expected) continue
    db.prepare(
      "UPDATE chunks SET state = 'succeeded', cancel_reason = NULL, revert_seq = NULL, version = version + 1, updated_at = ? WHERE id = ?",
    ).run(now, c.id)
    db.prepare("INSERT OR IGNORE INTO coverage(chunk_id, session_id, start_seq, end_seq, created_at) VALUES (?,?,?,?,?)").run(
      c.id,
      sessionId,
      c.start_seq,
      c.end_seq,
      now,
    )
    restored.push(c.id)
  }
  return restored
}

/** Restore coverage for a seq range so it is not re-cut after an unrevert. */
export function restoreCoverage(db: Database, sessionId: string, startSeq: number, endSeq: number, now = Date.now(), salt = "restore"): void {
  if (endSeq < startSeq) return
  db.prepare("INSERT OR IGNORE INTO coverage(chunk_id, session_id, start_seq, end_seq, created_at) VALUES (?,?,?,?,?)").run(
    `${salt}:${sessionId}:${startSeq}:${endSeq}`,
    sessionId,
    startSeq,
    endSeq,
    now,
  )
}

/** Release every lease held by an owner (graceful shutdown). */
export function releaseOwner(db: Database, owner: string, now = Date.now()): number {
  return db
    .prepare(
      "UPDATE chunks SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'running' AND lease_owner = ?",
    )
    .run(now, owner).changes
}

/** Merge coverage records into disjoint seq ranges. */
export function coveredRanges(db: Database, sessionId: string): [number, number][] {
  const rows = db
    .prepare("SELECT start_seq, end_seq FROM coverage WHERE session_id = ? ORDER BY start_seq")
    .all<{ start_seq: number; end_seq: number }>(sessionId)
  const out: [number, number][] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && r.start_seq <= last[1] + 1) last[1] = Math.max(last[1], r.end_seq)
    else out.push([r.start_seq, r.end_seq])
  }
  return out
}

/** Highest seq such that every message 1..seq is covered by successful observation. */
export function contiguousCoverage(db: Database, sessionId: string): number {
  const ranges = coveredRanges(db, sessionId)
  if (!ranges.length || ranges[0][0] > 1) return 0
  return ranges[0][1]
}

export function isSeqCovered(ranges: [number, number][], seq: number): boolean {
  return ranges.some(([a, b]) => seq >= a && seq <= b)
}

export function coverageStats(db: Database, sessionId: string) {
  const counts = db
    .prepare("SELECT state, COUNT(*) AS n, COALESCE(SUM(token_est),0) AS tokens FROM chunks WHERE session_id = ? GROUP BY state")
    .all<{ state: string; n: number; tokens: number }>(sessionId)
  const byState = Object.fromEntries(counts.map((c) => [c.state, { n: c.n, tokens: c.tokens }]))
  return byState as Record<string, { n: number; tokens: number }>
}
