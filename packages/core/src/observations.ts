import type { Database } from "./sqlite"
import { readFilterSql, type AccessContext, type ScopeKind } from "./scope"
import { HIGH_IMPACT_KINDS, LEARNING_KINDS, RESEARCH_KINDS, USER_SOURCED_KINDS, domainOfKind, type Payload } from "./schemas"
import { redact } from "./redact"
import { contentHash, estimateTokens, hashedShingles, INSTRUCTION_PATTERN, jaccard, MemoryError, randomId, safeJson, shingles } from "./util"

/** Kinds that assert what the user has mastered; an agent change to them needs human review. */
export const MASTERY_KINDS = new Set<string>(["demonstrated-skill"])

/**
 * Why an agent-authored write or replacement must wait for human review, or null when it
 * may go active (at session/project scope only). Agent writes never count as user
 * attribution, so user-sourced kinds always wait.
 */
export function agentReviewReason(input: { kind: string; content: string; payload?: Payload | null; replacing?: boolean }): string | null {
  if (USER_SOURCED_KINDS.has(input.kind)) return input.replacing ? "agent changed a user-sourced memory" : "user-sourced kind written by the agent"
  if (HIGH_IMPACT_KINDS.has(input.kind)) return `${input.kind} requires human review`
  if (MASTERY_KINDS.has(input.kind) && (input.replacing || input.payload?.mastery)) return "mastery claims require human review"
  if (INSTRUCTION_PATTERN.test(input.content)) return "instruction-like content requires human review"
  return null
}

export type ObservationRow = {
  id: string
  scope_kind: ScopeKind
  session_id: string | null
  project_id: string | null
  workspace: string
  chunk_id: string | null
  kind: string
  domain: string | null
  content: string
  content_hash: string
  event_at: number | null
  observed_at: number
  confidence: number
  evidence_type: string
  priority: string
  status: string
  visibility: string
  review_reason: string | null
  target_scope: string | null
  supersedes_id: string | null
  superseded_by: string | null
  expires_at: number | null
  pinned: number
  payload: string | null
  subject_key: string | null
  from_recall: number
  generation: number
  token_est: number
  actor: string
  updated_at: number
}

export type SourceRange = {
  sessionId: string
  startMessageId: string
  endMessageId: string
  startSeq: number
  endSeq: number
  partIds?: string[]
  transformVersion: number
}

/** Events that add rows or sources without changing an existing one; every other event bumps the memory generation. */
const ADDITIVE_EVENTS = new Set(["created", "reobserved", "promotion-refused"])

export function recordEvent(db: Database, observationId: string, type: string, actor: string, data?: unknown, at = Date.now()) {
  db.prepare("INSERT INTO observation_events(observation_id, type, actor, at, data) VALUES (?,?,?,?,?)").run(
    observationId,
    type,
    actor,
    at,
    data === undefined ? null : JSON.stringify(data),
  )
  if (!ADDITIVE_EVENTS.has(type)) bumpMemoryGeneration(db)
}

export const MEMORY_GENERATION_KEY = "memory_gen"

/**
 * Bump the DB-backed counter behind memoryGeneration(); call it in the transaction of any change
 * that can alter an already built memory block, so every process sharing the database sees it.
 * New observations alone do not bump it (a block stays stable for the rest of a turn).
 */
export function bumpMemoryGeneration(db: Database) {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
  ).run(MEMORY_GENERATION_KEY)
}

export const FORGOTTEN_CONTENT = "this content was forgotten earlier and will not be stored again"

export function ftsIndex(db: Database, id: string, content: string, kind: string) {
  if (!db.hasFts5) return
  db.prepare("DELETE FROM observations_fts WHERE observation_id = ?").run(id)
  db.prepare("INSERT INTO observations_fts(observation_id, content, kind) VALUES (?,?,?)").run(id, content, kind)
}

export function ftsRemove(db: Database, id: string) {
  if (!db.hasFts5) return
  db.prepare("DELETE FROM observations_fts WHERE observation_id = ?").run(id)
}

export function addSource(db: Database, observationId: string, s: SourceRange) {
  db.prepare(
    `INSERT OR IGNORE INTO observation_sources(observation_id, session_id, start_message_id, end_message_id, start_seq, end_seq, part_ids, transform_version)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    observationId,
    s.sessionId,
    s.startMessageId,
    s.endMessageId,
    s.startSeq,
    s.endSeq,
    s.partIds?.length ? JSON.stringify(s.partIds) : null,
    s.transformVersion,
  )
}

export function subjectKey(kind: string, payload: Payload, content: string): string | null {
  if ((kind === "preference" || kind === "learning-preference") && payload.key) return `pref:${payload.key.toLowerCase().trim()}`
  if (kind === "personal-fact" && payload.key) return `personal:${payload.key.toLowerCase().trim()}`
  if (kind === "demonstrated-skill" && payload.concept) return `skill:${payload.concept.toLowerCase().trim()}`
  if ((kind === "conclusion" || kind === "superseded-conclusion") && payload.claim) return `claim:${contentHash(payload.claim)}`
  if (kind === "goal" && payload.key) return `goal:${payload.key.toLowerCase().trim()}`
  void content
  return null
}

const SCOPE_RANK: Record<string, number> = { session: 0, project: 1, workspace: 2, user: 3 }

/**
 * A new row may supersede a conflicting one only from at least as wide a scope. A narrower
 * row (e.g. a session preference against a workspace one) is kept alongside: it ranks
 * higher in its own context without erasing the shared memory everywhere else.
 */
export function mayReplaceScope(newScope: string, oldScope: string): boolean {
  return (SCOPE_RANK[newScope] ?? -1) >= (SCOPE_RANK[oldScope] ?? Infinity)
}

const LEARNING_EVIDENCE = new Set<string>(LEARNING_KINDS.filter((k) => k !== "demonstrated-skill" && k !== "learning-preference"))
const RESEARCH_RECORDS = new Set<string>(RESEARCH_KINDS.filter((k) => k !== "conclusion" && k !== "superseded-conclusion"))

export type Placement = {
  scopeKind: ScopeKind
  status: "active" | "pending_review"
  targetScope: ScopeKind | null
  reviewReason: string | null
}

/**
 * Where an observation lands and whether it needs human review.
 * Anything not safely placeable stays session-scoped with a target scope pending review.
 */
export function placeObservation(input: {
  kind: string
  evidenceType: string
  scopeHint: ScopeKind
  hasUserSource: boolean
  payload: Payload
  conflict: boolean
  hasSession: boolean
}): Placement {
  const review = (reason: string, target: ScopeKind): Placement => ({
    scopeKind: input.hasSession ? "session" : target,
    status: "pending_review",
    targetScope: target,
    reviewReason: reason,
  })
  const hint = input.scopeHint
  if (input.kind === "demonstrated-skill" && input.payload.mastery)
    return review("mastery claims require human review", hint === "session" ? "workspace" : hint)
  if (HIGH_IMPACT_KINDS.has(input.kind)) return review(`${input.kind} requires human review`, hint === "session" ? "project" : hint)
  if (hint === "session") return { scopeKind: input.hasSession ? "session" : "project", status: "active", targetScope: null, reviewReason: null }
  if (input.conflict) {
    if (input.evidenceType === "explicit" && input.hasUserSource && USER_SOURCED_KINDS.has(input.kind))
      return { scopeKind: hint, status: "active", targetScope: null, reviewReason: null }
    return review("conflicts with an existing memory", hint)
  }
  if (hint === "project") return { scopeKind: "project", status: "active", targetScope: null, reviewReason: null }
  const explicitUser = input.evidenceType === "explicit" && input.hasUserSource
  if (hint === "workspace" && (LEARNING_EVIDENCE.has(input.kind) || RESEARCH_RECORDS.has(input.kind) || input.kind === "artifact"))
    // Shared memory needs the user's own words; tool output and agent text stay project-local.
    return { scopeKind: input.hasUserSource ? "workspace" : "project", status: "active", targetScope: null, reviewReason: null }
  if (explicitUser && (USER_SOURCED_KINDS.has(input.kind) || input.kind === "fact" || input.kind === "decision"))
    return { scopeKind: hint, status: "active", targetScope: null, reviewReason: null }
  return review(`inferred ${input.kind} proposed for ${hint} scope`, hint)
}

export function expiryFor(kind: string, now: number): number | null {
  const DAY = 86_400_000
  if (kind === "task-state") return now + 7 * DAY
  if (kind === "tool-outcome") return now + 21 * DAY
  if (kind === "next-review") return now + 60 * DAY
  return null
}

export function indexSuppressionShingles(db: Database, suppressionId: number, hashed: string[]) {
  if (!hashed.length) return
  const ins = db.prepare("INSERT OR IGNORE INTO suppression_shingles(shingle, suppression_id) VALUES (?,?)")
  for (const s of hashed) ins.run(s, suppressionId)
}

export function rebuildSuppressionShingles(db: Database) {
  db.exec("DELETE FROM suppression_shingles")
  const rows = db.prepare("SELECT id, shingles FROM suppressions WHERE shingles IS NOT NULL").all<{ id: number; shingles: string }>()
  for (const r of rows) indexSuppressionShingles(db, r.id, safeJson<string[]>(r.shingles, []))
}

/** With a target, an id suppressed by a scoped forget counts only while the row is inside that forget's boundary. */
export function isIdSuppressed(db: Database, id: string, target?: SuppressionTarget): boolean {
  const row = db.prepare("SELECT scope FROM suppressions WHERE kind = 'observation' AND value = ?").get<{ scope: string | null }>(id)
  return !!row && suppressionApplies(row.scope, target)
}

const GENERATION_KEY = "suppression_gen"

/** Monotonic counter bumped by every suppression insert or widening (backups record the value they were scrubbed at). */
export function suppressionGeneration(db: Database, schema = "main"): number {
  const row = db.prepare(`SELECT value FROM ${schema}.meta WHERE key = ?`).get<{ value: string }>(GENERATION_KEY)
  const n = Number(row?.value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function bumpSuppressionGeneration(db: Database) {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
  ).run(GENERATION_KEY)
}

/** Boundary of a scoped (agent) forget. Content and observation suppressions store a list of these; NULL means global. */
export type SuppressionScope = { w: string; p: string | null }

/** Where a piece of content lives, as seen by scoped suppressions (an observation row or a topic's scope). */
export type SuppressionTarget = { scope_kind: string; project_id: string | null; workspace: string }

/** Same boundary as a scoped caller's forget: user rows everywhere, workspace rows by workspace, else by project. */
export function scopeCovers(scope: SuppressionScope, target: SuppressionTarget): boolean {
  if (target.scope_kind === "user") return true
  if (target.scope_kind === "workspace") return target.workspace === scope.w
  return !!target.project_id && target.project_id === scope.p
}

function parseScopes(raw: string | null | undefined): SuppressionScope[] | null {
  if (!raw) return null
  const list = safeJson<SuppressionScope[]>(raw, [])
  return Array.isArray(list) && list.length ? list : null
}

/** Without a target every suppression applies (callers that cannot say where content lives stay conservative). */
function suppressionApplies(raw: string | null | undefined, target?: SuppressionTarget): boolean {
  const scopes = parseScopes(raw)
  if (!scopes || !target) return true
  return scopes.some((s) => scopeCovers(s, target))
}

/** Target for a topic/journey scope key (`project:<id>`, `workspace:<name>`, `user:*`). */
export function suppressionTarget(db: Database, scopeKey: string): SuppressionTarget | undefined {
  const i = scopeKey.indexOf(":")
  const kind = i < 0 ? scopeKey : scopeKey.slice(0, i)
  const id = i < 0 ? "" : scopeKey.slice(i + 1)
  if (kind === "workspace") return { scope_kind: "workspace", project_id: null, workspace: id }
  if (kind === "project") {
    const ws = db.prepare("SELECT workspace FROM projects WHERE id = ?").get<{ workspace: string }>(id)?.workspace ?? ""
    return { scope_kind: "project", project_id: id, workspace: ws }
  }
  if (kind === "user") return { scope_kind: "user", project_id: null, workspace: "" }
  return undefined
}

/** Target for an observation row; a pending row is checked at the scope it is proposed for. */
export function suppressionTargetForRow(row: {
  scope_kind: string
  project_id: string | null
  workspace: string
  status?: string
  target_scope?: string | null
}): SuppressionTarget {
  const kind = row.status === "pending_review" && row.target_scope ? row.target_scope : row.scope_kind
  return { scope_kind: kind, project_id: row.project_id, workspace: row.workspace }
}

export type SuppressionInput = {
  kind: string
  value: string
  shingles?: string[] | null
  reason?: string | null
  createdAt: number
  /** null = global. Scopes of the same (kind, value) are unioned; any global entry wins. */
  scope?: SuppressionScope[] | null
}

/**
 * Insert or widen a suppression (idempotent; used by forget, restore and backup scrubbing).
 * Returns whether anything changed; every change bumps the suppression generation.
 */
export function upsertSuppression(db: Database, s: SuppressionInput): boolean {
  const scope = s.scope?.length ? s.scope : null
  const sh = s.shingles?.length ? s.shingles : null
  let changed =
    db
      .prepare("INSERT OR IGNORE INTO suppressions(kind, value, shingles, reason, created_at, scope) VALUES (?,?,?,?,?,?)")
      .run(s.kind, s.value, sh ? JSON.stringify(sh) : null, s.reason ?? null, s.createdAt, scope ? JSON.stringify(scope) : null).changes > 0
  const row = db
    .prepare("SELECT id, shingles, scope FROM suppressions WHERE kind = ? AND value = ?")
    .get<{ id: number; shingles: string | null; scope: string | null }>(s.kind, s.value)
  if (!row) return changed
  const existing = parseScopes(row.scope)
  if (existing && !changed) {
    let merged: SuppressionScope[] | null = null
    if (scope) {
      const key = (x: SuppressionScope) => `${x.w}\u0000${x.p ?? ""}`
      const seen = new Set(existing.map(key))
      const extra = scope.filter((x) => !seen.has(key(x)))
      merged = extra.length ? [...existing, ...extra] : existing
    }
    if (merged !== existing) {
      db.prepare("UPDATE suppressions SET scope = ? WHERE id = ?").run(merged ? JSON.stringify(merged) : null, row.id)
      changed = true
    }
  }
  if (sh) {
    if (!row.shingles) {
      db.prepare("UPDATE suppressions SET shingles = ? WHERE id = ?").run(JSON.stringify(sh), row.id)
      changed = true
    }
    indexSuppressionShingles(db, row.id, sh)
  }
  if (changed) {
    bumpSuppressionGeneration(db)
    bumpMemoryGeneration(db)
  }
  return changed
}

/** The suppression withholding content from a target; `scope` null means a global (user) forget. */
export type SuppressionMatch = { scope: SuppressionScope[] | null }

/**
 * Exact hash or near-duplicate (shingle Jaccard >= 0.6) of forgotten content.
 * With a target, suppressions from scoped forgets apply only inside their boundary.
 */
export function suppressionMatch(db: Database, content: string, target?: SuppressionTarget): SuppressionMatch | undefined {
  const hash = contentHash(content)
  const exact = db.prepare("SELECT scope FROM suppressions WHERE kind = 'content' AND value = ?").get<{ scope: string | null }>(hash)
  if (exact && suppressionApplies(exact.scope, target)) return { scope: parseScopes(exact.scope) }
  const sh = hashedShingles(content)
  if (!sh.length) return undefined
  const candidateIds = new Set<number>()
  for (let i = 0; i < sh.length; i += 400) {
    const batch = sh.slice(i, i + 400)
    const hits = db
      .prepare(`SELECT DISTINCT suppression_id FROM suppression_shingles WHERE shingle IN (${batch.map(() => "?").join(",")})`)
      .all<{ suppression_id: number }>(...batch)
    for (const h of hits) candidateIds.add(h.suppression_id)
  }
  for (const id of candidateIds) {
    const row = db
      .prepare("SELECT shingles, scope FROM suppressions WHERE id = ? AND kind = 'content' AND shingles IS NOT NULL")
      .get<{ shingles: string; scope: string | null }>(id)
    if (row && suppressionApplies(row.scope, target) && jaccard(sh, safeJson<string[]>(row.shingles, [])) >= 0.6) return { scope: parseScopes(row.scope) }
  }
  return undefined
}

export function isSuppressed(db: Database, content: string, target?: SuppressionTarget): boolean {
  return !!suppressionMatch(db, content, target)
}

/** Free text stored next to a memory (supersede/promotion reasons, journey entries): redacted, and empty when it matches forgotten content. */
export function storableText(db: Database, text: string | null | undefined, target?: SuppressionTarget, max = Infinity): string {
  const clean = redact(text ?? "").text.trim().slice(0, max)
  return clean && !isSuppressed(db, clean, target) ? clean : ""
}

const REASON_MAX = 500

function storableReason(db: Database, reason: string | null | undefined, target?: SuppressionTarget): string {
  return storableText(db, reason, target, REASON_MAX)
}

export type NewObservation = {
  id: string
  scopeKind: ScopeKind
  sessionId: string | null
  projectId: string | null
  workspace: string
  chunkId: string | null
  kind: string
  content: string
  eventAt: number | null
  observedAt: number
  confidence: number
  evidenceType: string
  priority: string
  status: string
  reviewReason?: string | null
  targetScope?: string | null
  supersedesId?: string | null
  payload?: Payload | null
  fromRecall?: boolean
  generation?: number
  actor: string
  sources: SourceRange[]
}

export type InsertOutcome = { id: string; outcome: "inserted" | "merged" | "suppressed" | "exists" }

function findDuplicate(db: Database, o: NewObservation, hash: string): string | undefined {
  const scopeClause =
    o.scopeKind === "session"
      ? "session_id = ?"
      : o.scopeKind === "project"
        ? "scope_kind = 'project' AND project_id = ?"
        : o.scopeKind === "workspace"
          ? "scope_kind = 'workspace' AND workspace = ?"
          : "scope_kind = 'user' AND ? IS NOT NULL"
  const key = o.scopeKind === "session" ? o.sessionId : o.scopeKind === "project" ? o.projectId : o.workspace
  const exact = db
    .prepare(`SELECT id FROM observations WHERE content_hash = ? AND status IN ('active','pending_review') AND ${scopeClause} LIMIT 1`)
    .get<{ id: string }>(hash, key)
  if (exact) return exact.id
  const mine = shingles(o.content)
  if (mine.length < 3) return undefined
  const recent = db
    .prepare(
      `SELECT id, content FROM observations WHERE kind = ? AND status IN ('active','pending_review') AND ${scopeClause}
       ORDER BY observed_at DESC LIMIT 200`,
    )
    .all<{ id: string; content: string }>(o.kind, key)
  return recent.find((r) => jaccard(mine, shingles(r.content)) >= 0.8)?.id
}

/**
 * Idempotent insert with suppression and duplicate merging. Call inside a transaction.
 * Suppressions are checked where the row lands (a pending row: its proposed scope), so a
 * scoped forget elsewhere neither blocks it nor reveals itself.
 */
export function insertObservation(db: Database, o: NewObservation): InsertOutcome {
  if (db.prepare("SELECT 1 FROM observations WHERE id = ?").get(o.id)) return { id: o.id, outcome: "exists" }
  const target = suppressionTargetForRow({ scope_kind: o.scopeKind, project_id: o.projectId, workspace: o.workspace, status: o.status, target_scope: o.targetScope })
  if (isIdSuppressed(db, o.id, target) || isSuppressed(db, o.content, target)) return { id: o.id, outcome: "suppressed" }
  const hash = contentHash(o.content)
  const dup = findDuplicate(db, o, hash)
  if (dup) {
    for (const s of o.sources) addSource(db, dup, s)
    recordEvent(db, dup, "reobserved", o.actor, { chunk: o.chunkId }, o.observedAt)
    return { id: dup, outcome: "merged" }
  }
  const payload = o.payload ?? {}
  db.prepare(
    `INSERT INTO observations(id, scope_kind, session_id, project_id, workspace, chunk_id, kind, domain, content, content_hash,
       event_at, observed_at, confidence, evidence_type, priority, status, visibility, review_reason, target_scope, supersedes_id,
       expires_at, payload, subject_key, from_recall, generation, token_est, actor, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'visible', ?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.id,
    o.scopeKind,
    o.sessionId,
    o.projectId,
    o.workspace,
    o.chunkId,
    o.kind,
    domainOfKind(o.kind),
    o.content,
    hash,
    o.eventAt,
    o.observedAt,
    o.confidence,
    o.evidenceType,
    o.priority,
    o.status,
    o.reviewReason ?? null,
    o.targetScope ?? null,
    o.supersedesId ?? null,
    expiryFor(o.kind, o.observedAt),
    Object.keys(payload).length ? JSON.stringify(payload) : null,
    subjectKey(o.kind, payload, o.content),
    o.fromRecall ? 1 : 0,
    o.generation ?? 0,
    estimateTokens(o.content),
    o.actor,
    o.observedAt,
  )
  for (const s of o.sources) addSource(db, o.id, s)
  ftsIndex(db, o.id, o.content, o.kind)
  recordEvent(db, o.id, "created", o.actor, { scope: o.scopeKind, status: o.status }, o.observedAt)
  if (o.status === "pending_review") openReview(db, "observation", o.id, o.reviewReason ?? "needs review", { targetScope: o.targetScope }, o.observedAt)
  return { id: o.id, outcome: "inserted" }
}

export function findConflict(db: Database, key: string | null, hash: string, workspace: string, projectId: string | null): ObservationRow | undefined {
  if (!key) return undefined
  return db
    .prepare(
      `SELECT * FROM observations WHERE subject_key = ? AND status = 'active' AND content_hash != ?
       AND (scope_kind = 'user' OR (scope_kind = 'workspace' AND workspace = ?) OR (scope_kind IN ('project','session') AND project_id = ?))
       ORDER BY observed_at DESC LIMIT 1`,
    )
    .get<ObservationRow>(key, hash, workspace, projectId)
}

export function openReview(db: Database, kind: string, refId: string, reason: string, data?: unknown, now = Date.now()): string {
  const existing = db
    .prepare("SELECT id FROM review_items WHERE kind = ? AND ref_id = ? AND state = 'open'")
    .get<{ id: string }>(kind, refId)
  if (existing) return existing.id
  const id = randomId("rev")
  db.prepare("INSERT INTO review_items(id, kind, ref_id, reason, state, data, created_at) VALUES (?,?,?,?, 'open', ?, ?)").run(
    id,
    kind,
    refId,
    reason,
    data === undefined ? null : JSON.stringify(data),
    now,
  )
  return id
}

function resolveReviews(db: Database, refId: string, state: "approved" | "rejected", by: string, now: number) {
  db.prepare("UPDATE review_items SET state = ?, resolved_at = ?, resolved_by = ? WHERE ref_id = ? AND state = 'open'").run(state, now, by, refId)
}

export function getObservation(db: Database, id: string): ObservationRow | undefined {
  return db.prepare("SELECT * FROM observations WHERE id = ?").get<ObservationRow>(id)
}

export function getSources(db: Database, id: string) {
  return db
    .prepare("SELECT * FROM observation_sources WHERE observation_id = ? ORDER BY session_id, start_seq")
    .all<{
      observation_id: string
      session_id: string
      start_message_id: string
      end_message_id: string
      start_seq: number
      end_seq: number
      part_ids: string | null
      transform_version: number
    }>(id)
}

/**
 * Approve: activate, and move into its target scope if one was proposed. A pending
 * replacement (supersedes_id set while its predecessor is still active) supersedes the
 * predecessor only now. Throws MemoryError(forgotten, 409) for content (or an id) forgotten
 * at the scope it moves into.
 */
export function approveObservation(db: Database, id: string, actor = "user", edit?: { content?: string }, now = Date.now()): boolean {
  return db.tx(() => {
    const o = getObservation(db, id)
    if (!o || (o.status !== "pending_review" && o.status !== "active")) return false
    const scope = (o.target_scope as ScopeKind | null) ?? o.scope_kind
    const content = redact(edit?.content?.trim() || o.content).text
    if (!content) return false
    const target: SuppressionTarget = { scope_kind: scope, project_id: o.project_id, workspace: o.workspace }
    if (isIdSuppressed(db, id, target) || isSuppressed(db, content, target)) throw new MemoryError(FORGOTTEN_CONTENT, "forgotten", 409)
    const conflict = findConflict(db, o.subject_key, contentHash(content), o.workspace, o.project_id)
    db.prepare(
      `UPDATE observations SET status = 'active', scope_kind = ?, target_scope = NULL, review_reason = NULL, content = ?, content_hash = ?,
         token_est = ?, updated_at = ? WHERE id = ?`,
    ).run(scope, content, contentHash(content), estimateTokens(content), now, id)
    if (conflict && conflict.id !== id && conflict.id !== o.supersedes_id && mayReplaceScope(scope, conflict.scope_kind))
      supersedeInternal(db, conflict.id, id, actor, "approved replacement", now)
    completePendingSupersede(db, id, actor, now)
    ftsIndex(db, id, content, o.kind)
    recordEvent(db, id, "approved", actor, { scope, edited: content !== o.content }, now)
    resolveReviews(db, id, "approved", actor, now)
    return true
  })
}

/**
 * Finish a replacement that waited for review: once the successor is active, its
 * still-active predecessor becomes superseded. Call inside a transaction.
 */
export function completePendingSupersede(db: Database, id: string, actor: string, now = Date.now()): boolean {
  const o = getObservation(db, id)
  if (!o || o.status !== "active" || !o.supersedes_id) return false
  const old = getObservation(db, o.supersedes_id)
  if (!old || old.status !== "active" || old.superseded_by) return false
  const reason = db
    .prepare("SELECT data FROM observation_events WHERE observation_id = ? AND type = 'created' ORDER BY id LIMIT 1")
    .get<{ data: string | null }>(id)
  const data = safeJson<{ reason?: string }>(reason?.data, {})
  supersedeInternal(db, old.id, id, actor, data.reason || "approved replacement", now)
  return true
}

export function rejectObservation(db: Database, id: string, actor = "user", now = Date.now()): boolean {
  return db.tx(() => {
    const o = getObservation(db, id)
    if (!o) return false
    db.prepare("UPDATE observations SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, id)
    ftsRemove(db, id)
    recordEvent(db, id, "rejected", actor, undefined, now)
    resolveReviews(db, id, "rejected", actor, now)
    return true
  })
}

/** Throws MemoryError(forgotten, 409) when the new text is forgotten at the row's scope. */
export function editObservation(db: Database, id: string, content: string, actor = "user", now = Date.now()): boolean {
  return db.tx(() => {
    const o = getObservation(db, id)
    if (!o || o.status === "forgotten") return false
    const text = content.trim()
    if (!text) return false
    if (isSuppressed(db, text, suppressionTargetForRow(o))) throw new MemoryError(FORGOTTEN_CONTENT, "forgotten", 409)
    db.prepare("UPDATE observations SET content = ?, content_hash = ?, token_est = ?, evidence_type = 'explicit', updated_at = ? WHERE id = ?").run(
      text,
      contentHash(text),
      estimateTokens(text),
      now,
      id,
    )
    ftsIndex(db, id, text, o.kind)
    recordEvent(db, id, "edited", actor, { previousHash: o.content_hash }, now)
    return true
  })
}

export function setPinned(db: Database, id: string, pinned: boolean, actor = "user", now = Date.now()): boolean {
  return db.tx(() => {
    const r = db.prepare("UPDATE observations SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, now, id)
    if (r.changes) recordEvent(db, id, pinned ? "pinned" : "unpinned", actor, undefined, now)
    return r.changes > 0
  })
}

/** The reason is stored redacted, and dropped when it matches content forgotten at the old row's scope. */
function supersedeInternal(db: Database, oldId: string, newId: string, actor: string, reason: string, now: number) {
  const old = getObservation(db, oldId)
  db.prepare("UPDATE observations SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status IN ('active','pending_review')").run(
    newId,
    now,
    oldId,
  )
  db.prepare("UPDATE observations SET supersedes_id = COALESCE(supersedes_id, ?) WHERE id = ?").run(oldId, newId)
  recordEvent(db, oldId, "superseded", actor, { by: newId, reason: storableReason(db, reason, old && suppressionTargetForRow(old)) }, now)
}

/**
 * Supersede keeps history: the old record stays, marked as no longer current.
 *
 * An agent replacement of a user-sourced, high-impact or mastery memory (or with
 * instruction-like content) is stored as a pending_review successor linked through
 * supersedes_id; the old row stays active until the successor is approved, and
 * rejecting the successor leaves it untouched. Agents may only replace active rows.
 */
export function supersedeObservation(
  db: Database,
  oldId: string,
  replacement: { content: string; reason: string; actor?: string },
  now = Date.now(),
): string | undefined {
  return db.tx(() => {
    const old = getObservation(db, oldId)
    if (!old || old.status === "forgotten") return undefined
    const actor = replacement.actor ?? "user"
    const agent = actor !== "user"
    if (agent && old.status !== "active") return undefined
    const text = redact(replacement.content).text.trim()
    if (!text) return undefined
    const target = suppressionTargetForRow(old)
    if (isSuppressed(db, text, target)) return undefined
    const reason = storableReason(db, replacement.reason, target)
    const id = randomId("obs")
    const sources = getSources(db, oldId).map((s) => ({
      sessionId: s.session_id,
      startMessageId: s.start_message_id,
      endMessageId: s.end_message_id,
      startSeq: s.start_seq,
      endSeq: s.end_seq,
      partIds: safeJson<string[]>(s.part_ids, []),
      transformVersion: s.transform_version,
    }))
    const evidence = agent ? "observed" : "explicit"
    const confidence = agent ? old.confidence : Math.max(old.confidence, 0.8)
    const review = agent
      ? agentReviewReason({ kind: old.kind, content: text, payload: safeJson<Payload>(old.payload, {}), replacing: true })
      : null
    const status = review ? "pending_review" : "active"
    const targetScope = review ? (old.target_scope ?? old.scope_kind) : null
    const reviewReason = review
    const scopeKind = review && old.session_id ? "session" : old.scope_kind
    db.prepare(
      `INSERT INTO observations(id, scope_kind, session_id, project_id, workspace, chunk_id, kind, domain, content, content_hash, event_at,
         observed_at, confidence, evidence_type, priority, status, visibility, review_reason, target_scope, supersedes_id, payload, subject_key, generation, token_est, actor, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'visible', ?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      scopeKind,
      old.session_id,
      old.project_id,
      old.workspace,
      old.chunk_id,
      old.kind,
      old.domain,
      text,
      contentHash(text),
      now,
      now,
      confidence,
      evidence,
      old.priority,
      status,
      reviewReason,
      targetScope,
      oldId,
      old.payload,
      old.subject_key,
      old.generation,
      estimateTokens(text),
      actor,
      now,
    )
    for (const s of sources) addSource(db, id, s)
    ftsIndex(db, id, text, old.kind)
    recordEvent(db, id, "created", actor, { supersedes: oldId, reason, status }, now)
    if (status === "pending_review") openReview(db, "observation", id, reviewReason ?? "needs review", { targetScope, supersedes: oldId }, now)
    else supersedeInternal(db, oldId, id, actor, reason, now)
    return id
  })
}

/**
 * Review items, newest first. With a ctx the readability filter runs in SQL before the
 * limit: a linked observation must pass the read policy (pending rows only in their own
 * session); a vault conflict must belong to the ctx's workspace or project topics.
 */
export function listReviewItems(db: Database, state = "open", limit = 200, ctx?: AccessContext) {
  const f = ctx ? readFilterSql(ctx, "o") : undefined
  const where = f
    ? `AND ((o.id IS NOT NULL AND ${f.sql}) OR (o.id IS NULL AND r.kind = 'vault-conflict'
         AND EXISTS (SELECT 1 FROM topics t WHERE t.id = r.ref_id AND t.scope_key IN (?, ?))))`
    : ""
  const params = f && ctx ? [...f.params, `workspace:${ctx.workspace}`, `project:${ctx.projectId}`] : []
  return db
    .prepare(
      `SELECT r.*, r.kind AS review_kind, o.content, o.kind, o.confidence, o.evidence_type, o.scope_kind, o.target_scope, o.session_id, o.project_id, o.workspace,
         o.status, o.visibility, o.supersedes_id
       FROM review_items r LEFT JOIN observations o ON o.id = r.ref_id
       WHERE r.state = ? ${where} ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all<any>(state, ...params, limit)
}

export function resolveReviewItem(db: Database, id: string, state: "approved" | "rejected", by = "user", now = Date.now()) {
  db.prepare("UPDATE review_items SET state = ?, resolved_at = ?, resolved_by = ? WHERE id = ?").run(state, now, by, id)
}

export type ListFilter = {
  scopeKind?: ScopeKind
  sessionId?: string
  projectId?: string
  workspace?: string
  kinds?: string[]
  evidence?: string[]
  statuses?: string[]
  before?: number
  limit?: number
}

export function listObservations(db: Database, f: ListFilter, extra?: { sql: string; params: any[] }): ObservationRow[] {
  const where: string[] = []
  const params: any[] = []
  if (f.scopeKind) {
    where.push("o.scope_kind = ?")
    params.push(f.scopeKind)
  }
  if (f.sessionId) {
    where.push("o.session_id = ?")
    params.push(f.sessionId)
  }
  if (f.projectId) {
    where.push("o.project_id = ?")
    params.push(f.projectId)
  }
  if (f.workspace) {
    where.push("o.workspace = ?")
    params.push(f.workspace)
  }
  if (f.kinds?.length) {
    where.push(`o.kind IN (${f.kinds.map(() => "?").join(",")})`)
    params.push(...f.kinds)
  }
  if (f.evidence?.length) {
    where.push(`o.evidence_type IN (${f.evidence.map(() => "?").join(",")})`)
    params.push(...f.evidence)
  }
  const statuses = f.statuses ?? ["active", "pending_review"]
  where.push(`o.status IN (${statuses.map(() => "?").join(",")})`)
  params.push(...statuses)
  if (f.before) {
    where.push("o.observed_at < ?")
    params.push(f.before)
  }
  if (extra) {
    where.push(extra.sql)
    params.push(...extra.params)
  }
  return db
    .prepare(`SELECT o.* FROM observations o WHERE ${where.join(" AND ")} ORDER BY o.observed_at DESC LIMIT ?`)
    .all<ObservationRow>(...params, f.limit ?? 100)
}

export function expireObservations(db: Database, now = Date.now()): number {
  const rows = db
    .prepare("SELECT id FROM observations WHERE status = 'active' AND pinned = 0 AND expires_at IS NOT NULL AND expires_at < ?")
    .all<{ id: string }>(now)
  if (!rows.length) return 0
  db.tx(() => {
    for (const r of rows) {
      db.prepare("UPDATE observations SET status = 'expired', updated_at = ? WHERE id = ?").run(now, r.id)
      recordEvent(db, r.id, "expired", "system", undefined, now)
    }
  })
  return rows.length
}

export function observationEvents(db: Database, id: string) {
  return db.prepare("SELECT * FROM observation_events WHERE observation_id = ? ORDER BY id").all<any>(id)
}
