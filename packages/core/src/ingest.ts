import type { Database } from "./sqlite"
import { SNAPSHOT_VERSION, snapshotParts, type OcMessage } from "./normalize"
import { queueChunk } from "./chunks"
import { bumpMemoryGeneration, upsertSuppression } from "./observations"
import { estimateTokens, sha256 } from "./util"

/** Titles of the sessions the observer/reflector runners create. */
export const RUNNER_TITLES = new Set(["[memory] observer", "[memory] reflector"])
/** Agents the runners prompt; a session whose first message comes from one is a worker session. */
export const RUNNER_AGENTS = new Set(["om-observer", "om-reflector"])

/** Whether these messages open with a runner agent's message (a worker session, whatever its title). */
export function startedByRunner(messages: OcMessage[]): boolean {
  let first: OcMessage | undefined
  for (const m of messages)
    if (!first || m.info.time.created < first.info.time.created || (m.info.time.created === first.info.time.created && m.info.id < first.info.id)) first = m
  return !!first && RUNNER_AGENTS.has(first.info.agent ?? first.info.mode ?? "")
}

type ForkRef = { source_session: string; source_id: string }

/**
 * For a forked session, whether a copied part descends from forgotten content: its source
 * session was forgotten, or its source part (mapped by the lineage, or the same-hash part of
 * the mapped source message) was purged. Follows forks of forks. Undefined when the session
 * has no fork lineage.
 */
export function forkCopyForgotten(db: Database, sessionId: string): ((messageId: string, partId: string, hash: string) => boolean) | undefined {
  if (!db.prepare("SELECT 1 FROM fork_map WHERE target_session = ? LIMIT 1").get(sessionId)) return undefined
  const mapped = db.prepare("SELECT source_session, source_id FROM fork_map WHERE target_session = ? AND target_id = ? AND kind = ?")
  const sessionGone = db.prepare("SELECT 1 FROM suppressions WHERE kind = 'session' AND value = ?")
  const partGone = db.prepare(
    "SELECT 1 FROM suppressions WHERE kind = 'part' AND value = ? UNION ALL SELECT 1 FROM source_parts WHERE id = ? AND suppressed = 1 LIMIT 1",
  )
  const sameHash = db.prepare("SELECT id FROM source_parts WHERE message_id = ? AND hash = ? ORDER BY suppressed DESC LIMIT 1")
  const messageOf = db.prepare("SELECT message_id FROM source_parts WHERE id = ?")
  return (messageId, partId, hash) => {
    let session = sessionId
    let msg: string | undefined = messageId
    let part: string | undefined = partId
    for (let hop = 0; hop < 64 && (msg || part); hop++) {
      const m: ForkRef | undefined = msg ? mapped.get<ForkRef>(session, msg, "message") : undefined
      const p: ForkRef | undefined = part ? mapped.get<ForkRef>(session, part, "part") : undefined
      const src = p ?? m
      if (!src) return false
      if (sessionGone.get(src.source_session)) return true
      const srcPart: string | undefined = p?.source_id ?? (m ? sameHash.get<{ id: string }>(m.source_id, hash)?.id : undefined)
      if (srcPart && partGone.get(srcPart, srcPart)) return true
      session = src.source_session
      msg = m?.source_id ?? (srcPart ? messageOf.get<{ message_id: string }>(srcPart)?.message_id : undefined)
      part = srcPart
    }
    return false
  }
}

export type ProjectInfo = { id: string; workspace: string; domain: string; name?: string; directory?: string }

export function upsertProject(db: Database, p: ProjectInfo, now = Date.now()): void {
  db.prepare(
    `INSERT INTO projects(id, workspace, domain, name, directory, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET workspace = excluded.workspace, domain = excluded.domain,
       name = COALESCE(excluded.name, projects.name), directory = COALESCE(excluded.directory, projects.directory),
       updated_at = excluded.updated_at`,
  ).run(p.id, p.workspace, p.domain, p.name, p.directory, now, now)
}

export type SessionInfo = {
  id: string
  projectId: string
  parentId?: string
  title?: string
  internal?: boolean
  internalSource?: "explicit" | "title" | "agent"
  excluded?: boolean
}

export function upsertSession(db: Database, s: SessionInfo, now = Date.now()): void {
  db.prepare(
    `INSERT INTO sessions(id, project_id, parent_id, title, internal, internal_source, excluded, created_at, updated_at, last_activity_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title = COALESCE(excluded.title, sessions.title),
       parent_id = COALESCE(excluded.parent_id, sessions.parent_id),
       internal = MAX(sessions.internal, excluded.internal),
       internal_source = CASE WHEN excluded.internal = 1 THEN COALESCE(excluded.internal_source, sessions.internal_source) ELSE sessions.internal_source END,
       excluded = MAX(sessions.excluded, excluded.excluded),
       updated_at = excluded.updated_at`,
  ).run(s.id, s.projectId, s.parentId, s.title, s.internal ? 1 : 0, s.internalSource, s.excluded ? 1 : 0, now, now, now)
}

export type SessionRow = {
  id: string
  project_id: string
  parent_id: string | null
  title: string | null
  internal: number
  internal_source: string | null
  excluded: number
  paused: number
  deleted_at: number | null
  revert_message_id: string | null
  fork_source: string | null
  fork_boundary_seq: number | null
  fork_boundary_message_id: string | null
  last_activity_at: number | null
}

export function getSession(db: Database, id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get<SessionRow>(id)
}

export type IngestOptions = {
  captureReasoning: boolean
  toolOutputMax: number
  staleIncompleteMs: number
  /** Active revert point: this message and everything after it is not captured. */
  stopAt?: string | null
  now?: number
}

export type IngestResult = { captured: number; appendedParts: number; lastSeq: number; pendingIncomplete: boolean }

function isComplete(m: OcMessage, now: number, staleMs: number): boolean {
  if (m.info.role === "user") return true
  if (m.info.time.completed) return true
  return now - m.info.time.created > staleMs
}

/**
 * Resolve exclusive fork boundaries that arrived before their source message. Until this
 * runs, recordForkLineage keeps the boundary at zero so no source row can leak past an
 * unresolved marker. The first source message therefore resolves safely to boundary zero.
 */
export function resolveForkBoundaries(db: Database, sourceSessionId: string, now = Date.now()): number {
  const changed = db
    .prepare(
      `UPDATE sessions SET
         fork_boundary_seq = (
           SELECT m.seq - 1 FROM source_messages m
           WHERE m.session_id = sessions.fork_source AND m.id = sessions.fork_boundary_message_id
         ),
         fork_boundary_message_id = NULL,
         updated_at = ?
       WHERE fork_source = ? AND fork_boundary_message_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM source_messages m
           WHERE m.session_id = sessions.fork_source AND m.id = sessions.fork_boundary_message_id
         )`,
    )
    .run(now, sourceSessionId).changes
  if (changed) bumpMemoryGeneration(db)
  return changed
}

/**
 * Durable ingestion: snapshot the contiguous prefix of completed messages.
 * Existing parts are never rewritten (no downgrade after OpenCode compaction);
 * new parts on an already captured message are appended.
 */
export function ingestMessages(db: Database, sessionId: string, messages: OcMessage[], opts: IngestOptions): IngestResult {
  const now = opts.now ?? Date.now()
  const sorted = [...messages].sort((a, b) =>
    a.info.time.created === b.info.time.created
      ? a.info.id.localeCompare(b.info.id)
      : a.info.time.created - b.info.time.created,
  )
  return db.tx(() => {
    const state = db.prepare("SELECT last_seq FROM ingest_state WHERE session_id = ?").get<{ last_seq: number }>(sessionId)
    let lastSeq = state?.last_seq ?? 0
    let captured = 0
    let appendedParts = 0
    let pendingIncomplete = false
    const suppressed = new Set(
      db
        .prepare("SELECT value FROM suppressions WHERE kind = 'part'")
        .all<{ value: string }>()
        .map((r) => r.value),
    )
    const copyForgotten = forkCopyForgotten(db, sessionId)
    /** A suppressed part, or a fork copy of forgotten content (then suppressed under its own id too). */
    const forgotten = (messageId: string, p: { id: string; hash: string }): boolean => {
      if (suppressed.has(p.id)) return true
      if (!copyForgotten?.(messageId, p.id, p.hash)) return false
      suppressed.add(p.id)
      upsertSuppression(db, { kind: "part", value: p.id, reason: "fork_of_forgotten", createdAt: now })
      return true
    }
    const insertPart = db.prepare(
      `INSERT OR IGNORE INTO source_parts(id, message_id, session_id, ord, type, tool, text, redactions, omitted, flags, hash, transform_version, suppressed)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const m of sorted) {
      if (opts.stopAt && m.info.id === opts.stopAt) break
      if (!isComplete(m, now, opts.staleIncompleteMs)) {
        pendingIncomplete = true
        break
      }
      const existing = db
        .prepare("SELECT id, seq, hash, status, flags, completed_at FROM source_messages WHERE id = ?")
        .get<{ id: string; seq: number; hash: string; status: string; flags: string | null; completed_at: number | null }>(m.info.id)
      const snap = snapshotParts(m.parts, { captureReasoning: opts.captureReasoning, toolOutputMax: opts.toolOutputMax })
      const hash = sha256(snap.map((p) => p.hash).join(":"))
      if (existing) {
        if (existing.status === "reverted") continue
        if (existing.hash === hash) continue
        const knownRows = db
          .prepare("SELECT id, hash FROM source_parts WHERE message_id = ?")
          .all<{ id: string; hash: string }>(m.info.id)
        const known = new Map(knownRows.map((r) => [r.id, r.hash]))
        const priorFlags = existing.flags ? (JSON.parse(existing.flags) as string[]) : []
        const wasIncomplete = priorFlags.includes("incomplete") || existing.completed_at == null
        const changedPartIds: string[] = []
        const insertPartRow = (p: (typeof snap)[number]) => {
          const gone = forgotten(m.info.id, p)
          insertPart.run(
            p.id,
            m.info.id,
            sessionId,
            p.ord,
            p.type,
            p.tool,
            gone ? "[forgotten]" : p.text,
            gone ? 0 : p.redactions,
            p.omitted,
            JSON.stringify(p.flags),
            p.hash,
            SNAPSHOT_VERSION,
            gone ? 1 : 0,
          )
        }
        for (const p of snap) {
          const prevHash = known.get(p.id)
          if (prevHash === undefined) {
            insertPartRow(p)
            appendedParts++
            changedPartIds.push(p.id)
            continue
          }
          if (wasIncomplete && prevHash !== p.hash && !suppressed.has(p.id)) {
            db.prepare(
              `UPDATE source_parts SET text = ?, redactions = ?, omitted = ?, flags = ?, hash = ?, transform_version = ? WHERE id = ?`,
            ).run(p.text, p.redactions, p.omitted, JSON.stringify(p.flags), p.hash, SNAPSHOT_VERSION, p.id)
            appendedParts++
            changedPartIds.push(p.id)
          }
        }
        if (changedPartIds.length) {
          const tokens = db
            .prepare("SELECT COALESCE(SUM(LENGTH(text)),0) AS n FROM source_parts WHERE message_id = ?")
            .get<{ n: number }>(m.info.id)!.n
          const nextFlags = priorFlags.filter((f) => f !== "incomplete")
          if (m.info.role === "assistant" && !m.info.time.completed) nextFlags.push("incomplete")
          db.prepare("UPDATE source_messages SET hash = ?, token_est = ?, completed_at = ?, flags = ? WHERE id = ?").run(
            hash,
            Math.ceil(tokens / 4),
            m.info.time.completed ?? existing.completed_at,
            nextFlags.length ? JSON.stringify(nextFlags) : null,
            m.info.id,
          )
          const watermark = db.prepare("SELECT chunked_seq FROM ingest_state WHERE session_id = ?").get<{ chunked_seq: number }>(sessionId)
          const session = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get<{ project_id: string }>(sessionId)
          if (watermark && session && existing.seq <= watermark.chunked_seq) {
            queueChunk(db, {
              sessionId,
              projectId: session.project_id,
              startSeq: existing.seq,
              endSeq: existing.seq,
              tokenEst: Math.ceil(tokens / 4),
              reason: "appended",
              now,
              idSalt: `appended:${hash}`,
              partIds: changedPartIds,
            })
          }
        }
        continue
      }
      lastSeq++
      const tokens = snap.reduce((n, p) => n + estimateTokens(p.text), 0)
      const flags: string[] = []
      if (m.info.role === "assistant" && !m.info.time.completed) flags.push("incomplete")
      if (m.info.error?.name) flags.push(`error:${m.info.error.name}`)
      const model = m.info.model ? `${m.info.model.providerID}/${m.info.model.modelID}` : m.info.modelID ? `${m.info.providerID}/${m.info.modelID}` : null
      db.prepare(
        `INSERT INTO source_messages(id, session_id, seq, role, agent, model, created_at, completed_at, captured_at, hash, token_est, flags, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'present')`,
      ).run(
        m.info.id,
        sessionId,
        lastSeq,
        m.info.role,
        m.info.agent ?? m.info.mode ?? null,
        model,
        m.info.time.created,
        m.info.time.completed ?? null,
        now,
        hash,
        tokens,
        flags.length ? JSON.stringify(flags) : null,
      )
      for (const p of snap) {
        const gone = forgotten(m.info.id, p)
        insertPart.run(
          p.id,
          m.info.id,
          sessionId,
          p.ord,
          p.type,
          p.tool,
          gone ? "[forgotten]" : p.text,
          gone ? 0 : p.redactions,
          p.omitted,
          JSON.stringify(p.flags),
          p.hash,
          SNAPSHOT_VERSION,
          gone ? 1 : 0,
        )
      }
      captured++
    }
    db.prepare(
      `INSERT INTO ingest_state(session_id, last_seq, chunked_seq, updated_at) VALUES (?,?,0,?)
       ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
    ).run(sessionId, lastSeq, now)
    resolveForkBoundaries(db, sessionId, now)
    if (captured || appendedParts)
      db.prepare("UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(now, now, sessionId)
    return { captured, appendedParts, lastSeq, pendingIncomplete }
  })
}

/** Messages that vanished from OpenCode keep their snapshots but are marked removed. Reverted messages stay reverted. */
export function markRemovedMessages(db: Database, sessionId: string, presentIds: Set<string>): string[] {
  const rows = db
    .prepare("SELECT id FROM source_messages WHERE session_id = ? AND status = 'present'")
    .all<{ id: string }>(sessionId)
  const gone = rows.map((r) => r.id).filter((id) => !presentIds.has(id))
  if (!gone.length) return []
  db.tx(() => {
    for (const id of gone) db.prepare("UPDATE source_messages SET status = 'removed' WHERE id = ?").run(id)
  })
  return gone
}

export function seqOfMessage(db: Database, messageId: string): number | undefined {
  return db.prepare("SELECT seq FROM source_messages WHERE id = ?").get<{ seq: number }>(messageId)?.seq
}

export function unchunkedTokens(db: Database, sessionId: string): { tokens: number; oldest: number | null; count: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(m.token_est),0) AS tokens, MIN(m.captured_at) AS oldest, COUNT(*) AS count
       FROM source_messages m JOIN ingest_state s ON s.session_id = m.session_id
       WHERE m.session_id = ? AND m.seq > s.chunked_seq AND m.status != 'reverted'`,
    )
    .get<{ tokens: number; oldest: number | null; count: number }>(sessionId)
  return row ?? { tokens: 0, oldest: null, count: 0 }
}
