import type { Database } from "./sqlite"
import type { MemoryConfig } from "./config"
import type { ScopeKind } from "./scope"
import { assertLease, claimChunk, failChunk, markSucceeded, renewLease, StaleLeaseError, type Claim, type FailureOutcome } from "./chunks"
import { reserveRun, settleRun, usageOfError, withUsage } from "./cost"
import { buildObserverInput, type ObserverInput, type ObserverInputMessage, type StoredMessage, type StoredPart } from "./normalize"
import {
  bumpMemoryGeneration,
  findConflict,
  getObservation,
  insertObservation,
  isSuppressed,
  mayReplaceScope,
  placeObservation,
  recordEvent,
  subjectKey,
} from "./observations"
import { OBSERVER_SYSTEM, observerPrompt } from "./prompts"
import { redact } from "./redact"
import { classifyError, RunnerError, type ModelRunner, type RunResult } from "./runner"
import {
  ALL_KINDS,
  OBSERVER_JSON_SCHEMA,
  ObserverObservationSchema,
  ObserverOutputSchema,
  PayloadSchema,
  USER_SOURCED_KINDS,
  domainOfKind,
  type Payload,
} from "./schemas"
import { recordAttempt, rebuildConcept, upsertConcept } from "./learning"
import { DOMAIN_SCOPES_SQL, recordResearch, recomputeClaimStatus, releaseResearchSource } from "./research"
import { setArtifactConcepts } from "./artifacts"
import { readFilterSql } from "./scope"
import { clamp, contentHash, deterministicId, INSTRUCTION_PATTERN, normalizeForHash, safeJson, slugify, words } from "./util"

export type ValidatedObservation = {
  kind: string
  content: string
  eventAt: number | null
  confidence: number
  evidenceType: string
  priority: string
  scopeHint: ScopeKind
  payload: Payload
  start: ObserverInputMessage
  end: ObserverInputMessage
  hasUserSource: boolean
  fromRecall: boolean
  partIds: string[]
  /** Every part whose content the observer saw for this range (defaults to partIds). */
  visiblePartIds?: string[]
}

export type ValidationReport = {
  observations: ValidatedObservation[]
  currentTask?: string
  suggestedNext?: string
  dropped: { reason: string; content?: string }[]
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim()
}

/** Light, symmetric stemming (plural s/es/ies, ing, ed, doubled consonant, final e) for overlap only. */
export function stemWord(w: string): string {
  let s = w
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`
  else if (s.length > 4 && /(ss|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1)
  if (s.length > 4 && s.endsWith("ing")) s = s.slice(0, -3)
  else if (s.length > 4 && s.endsWith("ied")) s = `${s.slice(0, -3)}y`
  else if (s.length > 3 && s.endsWith("ed")) s = s.slice(0, -2)
  if (s.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss|zz)$/.test(s)) s = s.slice(0, -1)
  if (s.length > 2 && s.endsWith("e")) s = s.slice(0, -1)
  return s
}

/**
 * Words an observer wraps around what the user said ("User prefers …", "User wants to
 * be called …"). They are removed from the observation side before measuring overlap,
 * so third-person phrasing does not dilute attribution. Never counted as evidence.
 */
export const FRAMING_WORDS: ReadonlySet<string> = new Set(
  [
    "user", "users", "prefer", "prefers", "preferred", "preference", "want", "wants", "wanted", "like", "likes", "liked",
    "ask", "asks", "asked", "request", "requests", "requested", "call", "called", "name", "named", "is", "be", "to", "the",
    "would", "rather",
  ].map(stemWord),
)

/** Minimum share of the observation's words found in a verified quote and its surrounding window. */
const QUOTE_OVERLAP = 1 / 3
/** Minimum share of the observation's words found in one user message when there is no usable quote. */
const MESSAGE_OVERLAP = 0.5
const QUOTE_RADIUS = 12

function tokens(s: string): string[] {
  return normalizeForHash(s).split(" ").filter(Boolean)
}

function indexOfRun(hay: string[], needle: string[]): number {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, j) => hay[i + j] === w)) return i
  return -1
}

function contentWords(content: string): string[] {
  return words(content)
    .map(stemWord)
    .filter((w) => !FRAMING_WORDS.has(w))
}

function overlap(mine: string[], pool: string[]): number {
  const set = new Set(pool.map(stemWord))
  return mine.filter((w) => set.has(w)).length / mine.length
}

/**
 * The words around a quote that is verbatim (word boundaries) in one user message: a
 * quote of 3+ words anywhere, or a 2-word quote with a non-generic word that makes up
 * at least 60% of the sentence it came from ("use pnpm"). Shorter quotes never verify.
 */
function verifiedQuoteWindow(message: string, quote: string): string[] | undefined {
  const needle = tokens(quote)
  if (needle.length >= 3) {
    const hay = tokens(message)
    const i = indexOfRun(hay, needle)
    return i < 0 ? undefined : hay.slice(Math.max(0, i - QUOTE_RADIUS), i + needle.length + QUOTE_RADIUS)
  }
  if (needle.length !== 2 || !contentWords(quote).length) return undefined
  for (const sentence of message.split(/[.!?;\n]+/)) {
    const st = tokens(sentence)
    if (st.length && indexOfRun(st, needle) >= 0 && needle.length / st.length >= 0.6) return st
  }
  return undefined
}

/**
 * User attribution needs the words themselves to come from a genuine user message
 * (callers pass non-synthetic, non-recall user text, one entry per message). With a
 * verified quote, at least a third of the observation's words (stopwords and framing
 * words excluded, lightly stemmed) must appear in the quote and its window. Without
 * one, half of them must appear in a single user message — never in a concatenation
 * of several, which would let scattered words add up.
 */
export function attributedToUser(userText: string | readonly string[], quote: string | null | undefined, content: string): boolean {
  const messages = (typeof userText === "string" ? [userText] : [...userText]).filter((t) => t.trim())
  if (!messages.length) return false
  const mine = contentWords(content)
  if (!mine.length) return false
  const q = quote?.trim() ?? ""
  if (q) {
    for (const m of messages) {
      const window = verifiedQuoteWindow(m, q)
      if (window && overlap(mine, [...tokens(q), ...window]) >= QUOTE_OVERLAP) return true
    }
  }
  return messages.some((m) => overlap(mine, tokens(m)) >= MESSAGE_OVERLAP)
}

/** Recent non-synthetic user text in a session, for agent-write attribution. */
export function sessionUserText(db: Database, sessionId: string, limit = 30): string {
  const msgs = db
    .prepare(
      `SELECT id FROM source_messages WHERE session_id = ? AND role = 'user' AND status = 'present' ORDER BY seq DESC LIMIT ?`,
    )
    .all<{ id: string }>(sessionId, limit)
  if (!msgs.length) return ""
  const parts = db
    .prepare(
      `SELECT message_id, text, flags, suppressed FROM source_parts WHERE message_id IN (${msgs.map(() => "?").join(",")}) ORDER BY message_id, ord`,
    )
    .all<{ message_id: string; text: string; flags: string | null; suppressed: number }>(...msgs.map((m) => m.id))
  const chunks: string[] = []
  for (const p of parts) {
    if (p.suppressed) continue
    const flags = p.flags ? (JSON.parse(p.flags) as string[]) : []
    if (flags.includes("synthetic") || flags.includes("recall")) continue
    chunks.push(p.text)
  }
  return chunks.join("\n")
}

/**
 * Validate structured observer output against the chunk: refs must exist in the
 * chunk, quotes must be verbatim, user-sourced kinds need a user message, and
 * instruction-like content from non-user sources is dropped.
 */
export function validateObserverOutput(raw: unknown, input: ObserverInput, sourceText: Map<string, string>): ValidationReport {
  const top = ObserverOutputSchema.safeParse(raw)
  if (!top.success) throw new RunnerError("invalid_output", `observer output failed schema: ${top.error.message.slice(0, 500)}`)
  const refs = new Map(input.messages.map((m) => [m.ref, m]))
  const out: ValidatedObservation[] = []
  const dropped: ValidationReport["dropped"] = []
  for (const item of top.data.observations) {
    const parsed = ObserverObservationSchema.safeParse(item)
    if (!parsed.success) {
      dropped.push({ reason: "schema" })
      continue
    }
    const o = parsed.data
    let start = refs.get(o.sources.start.trim())
    let end = refs.get(o.sources.end.trim())
    if (!start || !end) {
      dropped.push({ reason: "unknown source ref", content: o.content })
      continue
    }
    if (start.seq > end.seq) [start, end] = [end, start]
    const range = input.messages.filter((m) => m.seq >= start!.seq && m.seq <= end!.seq)
    const fromRecall = range.every((m) => m.recallOnly)
    const rangeText = norm(range.map((m) => sourceText.get(m.id) ?? m.text).join("\n"))
    const userTexts = range
      .filter((m) => m.role === "user" && !m.recallOnly)
      .map((m) => m.authoredText || "")
      .filter((t) => t.trim())
    const kind = (ALL_KINDS as readonly string[]).includes(o.kind) && o.kind !== "condensed" ? o.kind : "fact"
    const content = redact(o.content.trim()).text
    if (!content) {
      dropped.push({ reason: "empty" })
      continue
    }
    const hasUser = attributedToUser(userTexts, o.quote, content)
    if (INSTRUCTION_PATTERN.test(content) && !hasUser) {
      dropped.push({ reason: "instruction-like content without a user source", content })
      continue
    }
    let evidenceType: string = o.evidenceType
    let scopeHint: ScopeKind = o.scopeHint
    let confidence = clamp(o.confidence, 0, 1)
    if (evidenceType === "explicit" && !hasUser) evidenceType = "observed"
    if (USER_SOURCED_KINDS.has(kind) && !hasUser) {
      evidenceType = "inferred"
      scopeHint = "session"
      confidence = Math.min(confidence, 0.4)
    }
    const payloadParse = PayloadSchema.safeParse(o.payload ?? {})
    const payload: Payload = payloadParse.success ? { ...payloadParse.data } : {}
    if (o.quote && !rangeText.includes(norm(o.quote))) confidence *= 0.8
    if (payload.quotation && !rangeText.includes(norm(payload.quotation))) {
      if (kind === "quotation") {
        dropped.push({ reason: "quotation not found in source", content })
        continue
      }
      delete payload.quotation
      confidence *= 0.8
    }
    if (fromRecall) {
      confidence = Math.min(confidence, 0.5)
      if (scopeHint !== "session") scopeHint = "session"
    }
    if (kind === "quiz-attempt" && payload.hints && payload.hints > 0) payload.independent = false
    const eventAt = o.eventAt ? Date.parse(o.eventAt) : NaN
    out.push({
      kind,
      content: content.slice(0, 1500),
      eventAt: Number.isFinite(eventAt) ? eventAt : null,
      confidence,
      evidenceType,
      priority: o.priority,
      scopeHint,
      payload,
      start,
      end,
      hasUserSource: hasUser,
      fromRecall,
      partIds: range.flatMap((m) => m.partIds),
      visiblePartIds: range.flatMap((m) => m.visiblePartIds ?? m.partIds),
    })
  }
  if (top.data.observations.length > 0 && out.length === 0 && dropped.every((d) => d.reason === "schema" || d.reason === "unknown source ref"))
    throw new RunnerError("invalid_output", `all ${dropped.length} observations were malformed`)
  return {
    observations: out,
    currentTask: top.data.currentTask ? redact(top.data.currentTask).text : undefined,
    suggestedNext: top.data.suggestedNext ? redact(top.data.suggestedNext).text : undefined,
    dropped,
  }
}

export type ChunkMaterial = {
  input: ObserverInput
  sourceText: Map<string, string>
  messages: StoredMessage[]
}

export function loadChunkMaterial(db: Database, claim: Claim, cfg: MemoryConfig): ChunkMaterial {
  const c = claim.chunk
  const messages = db
    .prepare(
      `SELECT id, seq, role, created_at, agent FROM source_messages WHERE session_id = ? AND seq BETWEEN ? AND ?
       AND status != 'reverted' ORDER BY seq`,
    )
    .all<StoredMessage>(c.session_id, c.start_seq, c.end_seq)
  const ids = messages.map((m) => m.id)
  const parts = ids.length
    ? db
        .prepare(
          `SELECT id, message_id, type, tool, text, flags, suppressed FROM source_parts WHERE message_id IN (${ids.map(() => "?").join(",")})
           ORDER BY message_id, ord`,
        )
        .all<StoredPart>(...ids)
    : []
  const input = buildObserverInput(messages, parts, {
    toolOutputMax: cfg.observe.observerToolOutputMax,
    focusPartIds: claim.chunk.part_ids ? safeJson<string[]>(claim.chunk.part_ids, []) : undefined,
  })
  const sourceText = new Map<string, string>()
  for (const p of parts) if (!p.suppressed) sourceText.set(p.message_id, `${sourceText.get(p.message_id) ?? ""}\n${p.text}`)
  return { input, sourceText, messages }
}

function knownContext(db: Database, sessionId: string, projectId: string, workspace: string): string {
  const f = readFilterSql({ sessionId, projectId, workspace })
  const rows = db
    .prepare(`SELECT o.content FROM observations o WHERE ${f.sql} AND (o.status != 'pending_review' OR o.actor = 'user') ORDER BY o.observed_at DESC LIMIT 25`)
    .all<{ content: string }>(...f.params)
  return rows.map((r) => `- ${r.content}`).join("\n")
}

export type CommitResult = { inserted: number; merged: number; suppressed: number; ids: string[] }

/** Persist validated observations and advance coverage in one transaction guarded by the lease. */
export function commitObservations(db: Database, claim: Claim, report: ValidationReport, now = Date.now()): CommitResult {
  return db.tx(() => {
    assertLease(db, claim)
    const c = claim.chunk
    const session = db
      .prepare("SELECT excluded, deleted_at FROM sessions WHERE id = ?")
      .get<{ excluded: number; deleted_at: number | null }>(c.session_id)
    const project = db.prepare("SELECT workspace FROM projects WHERE id = ?").get<{ workspace: string }>(c.project_id)
    const workspace = project?.workspace ?? "personal-knowledge"
    const result: CommitResult = { inserted: 0, merged: 0, suppressed: 0, ids: [] }
    const sessionBlocked = !session || !!session.excluded || session.deleted_at != null
    if (!sessionBlocked) {
      report.observations.forEach((o, index) => {
        if (observationTouchesForgotten(db, o)) {
          result.suppressed++
          return
        }
        const hash = contentHash(o.content)
        const key = subjectKey(o.kind, o.payload, o.content)
        const conflict = findConflict(db, key, hash, workspace, c.project_id)
        const place = placeObservation({
          kind: o.kind,
          evidenceType: o.evidenceType,
          scopeHint: o.scopeHint,
          hasUserSource: o.hasUserSource,
          payload: o.payload,
          conflict: !!conflict,
          hasSession: true,
        })
        const id = deterministicId("obs", c.id, index, hash)
        const r = insertObservation(db, {
          id,
          scopeKind: place.scopeKind,
          sessionId: c.session_id,
          projectId: c.project_id,
          workspace,
          chunkId: c.id,
          kind: o.kind,
          content: o.content,
          eventAt: o.eventAt ?? o.start.at,
          observedAt: now,
          confidence: o.confidence,
          evidenceType: o.evidenceType,
          priority: o.priority,
          status: place.status,
          reviewReason: place.reviewReason,
          targetScope: place.targetScope,
          payload: o.payload,
          fromRecall: o.fromRecall,
          actor: "observer",
          sources: [
            {
              sessionId: c.session_id,
              startMessageId: o.start.id,
              endMessageId: o.end.id,
              startSeq: o.start.seq,
              endSeq: o.end.seq,
              partIds: o.partIds,
              transformVersion: 1,
            },
          ],
        })
        if (r.outcome === "suppressed") {
          result.suppressed++
          return
        }
        if (r.outcome === "merged") result.merged++
        if (r.outcome === "inserted") {
          result.inserted++
          if (place.status === "active" && conflict && o.evidenceType === "explicit" && o.hasUserSource && mayReplaceScope(place.scopeKind, conflict.scope_kind)) {
            db.prepare("UPDATE observations SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(r.id, now, conflict.id)
            db.prepare("UPDATE observations SET supersedes_id = ? WHERE id = ?").run(conflict.id, r.id)
            recordEvent(db, conflict.id, "superseded", "observer", { by: r.id, reason: "user stated a new value" }, now)
          }
          if (place.status === "active") applyDomainHooks(db, { id: r.id, scopeKind: place.scopeKind, workspace, sessionId: c.session_id, o, now })
        }
        result.ids.push(r.id)
      })
      const sessionTarget = { scope_kind: "session", project_id: c.project_id, workspace }
      const task = report.currentTask && !isSuppressed(db, report.currentTask, sessionTarget) ? report.currentTask : null
      const next = report.suggestedNext && !isSuppressed(db, report.suggestedNext, sessionTarget) ? report.suggestedNext : null
      if (task || next) {
        db.prepare(
          `INSERT INTO session_state(session_id, current_task, suggested_next, chunk_id, updated_at) VALUES (?,?,?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET current_task = COALESCE(excluded.current_task, session_state.current_task),
             suggested_next = COALESCE(excluded.suggested_next, session_state.suggested_next), chunk_id = excluded.chunk_id, updated_at = excluded.updated_at`,
        ).run(c.session_id, task, next, c.id, now)
      }
    }
    markSucceeded(db, claim, now)
    return result
  })
}

/**
 * Forgotten while the observer ran: a part the observer actually saw (or that the
 * observation cites) is now suppressed or gone. Parts already omitted when the input
 * was built were never shown, so they do not void the observation.
 */
function observationTouchesForgotten(db: Database, o: ValidatedObservation): boolean {
  const ids = [...new Set([...(o.visiblePartIds ?? []), ...o.partIds])]
  if (!ids.length) return false
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400)
    const rows = db
      .prepare(`SELECT id, suppressed FROM source_parts WHERE id IN (${batch.map(() => "?").join(",")})`)
      .all<{ id: string; suppressed: number }>(...batch)
    if (rows.length !== batch.length || rows.some((r) => r.suppressed)) return true
  }
  return false
}

/** Learning/research tables are workspace-wide: only rows active at these scopes feed them. */
export function isDomainScope(scope: string): boolean {
  return scope === "workspace" || scope === "user"
}

/** Learning/research state feeds the memory block, so every hook write bumps the memory generation. */
function applyDomainHooks(db: Database, x: { id: string; scopeKind: ScopeKind; workspace: string; sessionId: string; o: ValidatedObservation; now: number }) {
  if (!isDomainScope(x.scopeKind)) return
  const { o } = x
  const at = o.eventAt ?? x.now
  const hooked =
    o.kind === "quiz-attempt" ||
    o.kind === "retention-check" ||
    o.kind === "demonstrated-skill" ||
    ((o.kind === "misconception" || o.kind === "hint-required" || o.kind === "prior-knowledge") && !!o.payload.concept) ||
    domainOfKind(o.kind) === "research" ||
    (o.kind === "artifact" && !!o.payload.path && !!o.payload.concept)
  if (hooked) bumpMemoryGeneration(db)
  if (o.kind === "quiz-attempt" || o.kind === "retention-check" || o.kind === "demonstrated-skill") {
    recordAttempt(db, {
      workspace: x.workspace,
      observationId: x.id,
      sessionId: x.sessionId,
      kind: o.kind,
      payload: o.payload,
      at,
      fromRecall: o.fromRecall,
    })
  } else if ((o.kind === "misconception" || o.kind === "hint-required" || o.kind === "prior-knowledge") && o.payload.concept) {
    upsertConcept(db, x.workspace, o.payload.concept, at)
  } else if (domainOfKind(o.kind) === "research") {
    recordResearch(db, { workspace: x.workspace, observationId: x.id, kind: o.kind, content: o.content, payload: o.payload, confidence: o.confidence, at })
  }
  if (o.kind === "artifact" && o.payload.path && o.payload.concept) setArtifactConcepts(db, o.payload.path, [o.payload.concept])
}

/**
 * Apply learning/research side effects for an already-stored observation (after approve,
 * promotion or a direct write). Only rows active and visible at workspace/user scope qualify.
 */
export function applyObservationDomainHooks(db: Database, id: string, now = Date.now()): void {
  const row = getObservation(db, id)
  if (!row || row.status !== "active" || row.visibility !== "visible" || !isDomainScope(row.scope_kind)) return
  const payload = safeJson<Payload>(row.payload, {})
  applyDomainHooks(db, {
    id: row.id,
    scopeKind: row.scope_kind,
    workspace: row.workspace,
    sessionId: row.session_id ?? "",
    now,
    o: {
      kind: row.kind,
      content: row.content,
      eventAt: row.event_at,
      confidence: row.confidence,
      evidenceType: row.evidence_type,
      priority: row.priority,
      scopeHint: row.scope_kind,
      payload,
      start: { ref: "", id: "", seq: 0, at: row.event_at ?? now, role: "user", text: "", authoredText: "", recallOnly: false, partIds: [] },
      end: { ref: "", id: "", seq: 0, at: row.event_at ?? now, role: "user", text: "", authoredText: "", recallOnly: false, partIds: [] },
      hasUserSource: false,
      fromRecall: !!row.from_recall,
      partIds: [],
    },
  })
}

const CLAIM_KINDS = new Set(["claim", "conclusion", "hypothesis"])
const EVIDENCE_KINDS = new Set(["evidence", "counter-evidence", "quotation"])

/** Statement hash of the claim a research observation creates or cites (mirrors recordResearch). */
function claimStatementHash(kind: string, content: string, payload: Payload): string | undefined {
  const claim = payload.claim?.trim()
  if (CLAIM_KINDS.has(kind)) return contentHash(claim || content)
  if ((EVIDENCE_KINDS.has(kind) || kind === "superseded-conclusion") && claim) return contentHash(claim)
  return undefined
}

/** Another active workspace/user research observation still creates (or, for superseded-conclusion, supersedes) this claim statement. */
function claimStillBacked(db: Database, workspace: string, hash: string, excludeId: string, superseding: boolean): boolean {
  const rows = db
    .prepare(
      `SELECT kind, content, payload FROM observations WHERE workspace = ? AND id != ? AND status = 'active' AND domain = 'research'
       AND scope_kind IN ${DOMAIN_SCOPES_SQL} LIMIT 5000`,
    )
    .all<{ kind: string; content: string; payload: string | null }>(workspace, excludeId)
  return rows.some(
    (r) => (r.kind === "superseded-conclusion") === superseding && claimStatementHash(r.kind, r.content, safeJson<Payload>(r.payload, {})) === hash,
  )
}

/**
 * Remove learning/research rows derived from an observation that did not survive review
 * (reject), left workspace/user scope, or had hooks applied while it was not eligible
 * (legacy): its learning attempts and concept rebuilds, its claim evidence, claims that
 * only it created, its superseded mark on a claim, and a research source nothing else uses.
 * forget.ts keeps its own scrubDomain for forgotten rows.
 */
export function scrubObservationDomain(db: Database, observationId: string, now = Date.now()): void {
  const o = getObservation(db, observationId)
  if (!o) return
  bumpMemoryGeneration(db)
  const payload = safeJson<Payload>(o.payload, {})
  const concepts = db.prepare("SELECT DISTINCT concept_id FROM learning_attempts WHERE observation_id = ?").all<{ concept_id: string }>(observationId)
  db.prepare("DELETE FROM learning_attempts WHERE observation_id = ?").run(observationId)
  const conceptIds = new Set(concepts.map((c) => c.concept_id))
  if (payload.concept) conceptIds.add(deterministicId("concept", o.workspace, slugify(payload.concept)))
  for (const id of conceptIds) rebuildConcept(db, id)

  const claimIds = new Set(
    db
      .prepare("SELECT DISTINCT claim_id FROM claim_evidence WHERE observation_id = ?")
      .all<{ claim_id: string }>(observationId)
      .map((c) => c.claim_id),
  )
  db.prepare("DELETE FROM claim_evidence WHERE observation_id = ?").run(observationId)
  const hash = claimStatementHash(o.kind, o.content, payload)
  if (hash) {
    const own = deterministicId("claim", o.workspace, hash)
    if (o.kind === "superseded-conclusion") {
      if (!claimStillBacked(db, o.workspace, hash, observationId, true))
        db.prepare("UPDATE research_claims SET status = 'open', updated_at = ? WHERE id = ? AND status = 'superseded'").run(now, own)
    }
    claimIds.add(own)
  }
  for (const claimId of claimIds) {
    const claim = db.prepare("SELECT statement_hash FROM research_claims WHERE id = ?").get<{ statement_hash: string }>(claimId)
    if (!claim) continue
    const evidenced = db.prepare("SELECT 1 FROM claim_evidence WHERE claim_id = ? LIMIT 1").get(claimId)
    if (!evidenced && !claimStillBacked(db, o.workspace, claim.statement_hash, observationId, false)) {
      db.prepare("DELETE FROM research_claims WHERE id = ?").run(claimId)
      continue
    }
    recomputeClaimStatus(db, claimId, now)
  }

  releaseResearchSource(db, o.workspace, payload, observationId)
}

/**
 * One-time cleanup of domain rows derived from observations that are not at workspace/user
 * scope (hooks used to run for any active row). Returns the number of observations scrubbed.
 */
export function scrubOutOfScopeDomain(db: Database, now = Date.now()): number {
  const MARK = "domain_scope_scrub_v1"
  if (db.prepare("SELECT 1 FROM runtime_state WHERE key = ?").get(MARK)) return 0
  return db.tx(() => {
    const rows = db
      .prepare(
        `SELECT id, workspace, kind, content, payload FROM observations
         WHERE scope_kind NOT IN ${DOMAIN_SCOPES_SQL} AND status != 'forgotten' AND (domain IN ('learning','research') OR kind = 'artifact')`,
      )
      .all<{ id: string; workspace: string; kind: string; content: string; payload: string | null }>()
    const exists = (sql: string, ...params: string[]) => !!db.prepare(sql).get(...params)
    let n = 0
    for (const r of rows) {
      const payload = safeJson<Payload>(r.payload, {})
      const hash = claimStatementHash(r.kind, r.content, payload)
      const locator = payload.doi?.trim() || payload.url?.trim()
      const derived =
        exists("SELECT 1 FROM learning_attempts WHERE observation_id = ?", r.id) ||
        exists("SELECT 1 FROM claim_evidence WHERE observation_id = ?", r.id) ||
        (!!hash && exists("SELECT 1 FROM research_claims WHERE id = ?", deterministicId("claim", r.workspace, hash))) ||
        (!!payload.concept && exists("SELECT 1 FROM learning_concepts WHERE id = ?", deterministicId("concept", r.workspace, slugify(payload.concept)))) ||
        (!!locator && exists("SELECT 1 FROM research_sources WHERE id = ?", deterministicId("src", r.workspace, locator)))
      if (!derived) continue
      scrubObservationDomain(db, r.id, now)
      n++
    }
    db.prepare("INSERT OR REPLACE INTO runtime_state(key, value, until, updated_at) VALUES (?, ?, NULL, ?)").run(MARK, String(n), now)
    return n
  })
}

export type ObserveDeps = {
  db: Database
  config: MemoryConfig
  runner: ModelRunner
  owner: string
  projectIds?: string[]
  includeInactiveBuffer?: boolean
  parentSessionFor?: (sessionId: string) => string | undefined
  directoryFor?: (projectId: string) => string | undefined
  signal?: AbortSignal
  now?: () => number
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void
}

export type ObserveOutcome =
  | { chunkId: string; status: "succeeded"; commit: CommitResult; dropped: number; tokens: number }
  | { chunkId: string; status: FailureOutcome; error: string; cls: string }
  | { chunkId: string; status: "stale" }

/** Claim and process a single chunk. Returns undefined when there is no work. */
export async function observeNext(deps: ObserveDeps): Promise<ObserveOutcome | undefined> {
  const now = deps.now ?? Date.now
  const { db, config } = deps
  const claim = claimChunk(db, deps.owner, {
    projectIds: deps.projectIds,
    leaseMs: config.observe.leaseMs,
    now: now(),
    includeInactiveBuffer: deps.includeInactiveBuffer,
  })
  if (!claim) return undefined
  const c = claim.chunk
  const fail = (err: RunnerError): ObserveOutcome => {
    const status = failChunk(db, claim, { cls: err.cls, message: err.message, retryAfterMs: err.retryAfterMs }, { maxAttempts: config.observe.maxAttempts, now: now() })
    deps.log?.(status === "quarantined" ? "error" : "warn", `observe ${c.id} ${status}: ${err.message}`, { cls: err.cls })
    return { chunkId: c.id, status, error: err.message, cls: err.cls }
  }
  const material = loadChunkMaterial(db, claim, config)
  const substantive = material.input.messages.filter((m) => !m.recallOnly && m.text.trim())
  if (!substantive.length) {
    try {
      const commit = commitObservations(db, claim, { observations: [], dropped: [] }, now())
      return { chunkId: c.id, status: "succeeded", commit, dropped: 0, tokens: 0 }
    } catch (e) {
      if (e instanceof StaleLeaseError) return { chunkId: c.id, status: "stale" }
      throw e
    }
  }
  if (material.input.tokens > config.observe.maxChunkTokens * 1.5 && c.end_seq > c.start_seq)
    return fail(new RunnerError("oversize", `observer input ${material.input.tokens} tokens exceeds limit`))

  let opId: string
  try {
    opId = reserveRun(db, config.cost, { kind: "observe", sessionId: c.session_id, projectId: c.project_id, refId: c.id, runner: deps.runner.id }, now())
  } catch (e) {
    return fail(classifyError(e))
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  deps.signal?.addEventListener("abort", onAbort)
  const renew = setInterval(() => {
    if (!renewLease(db, claim, config.observe.leaseMs, now())) controller.abort()
  }, Math.max(1000, Math.floor(config.observe.leaseMs / 3)))
  const timer = setTimeout(() => controller.abort(), config.runner.timeoutMs)
  renew.unref?.()
  timer.unref?.()
  let result: RunResult | undefined
  let settled = false
  const settle = (r: { cost: number; inputTokens: number; outputTokens: number; model?: string }, status: "succeeded" | "failed" | "stale", err?: RunnerError) => {
    settleRun(db, opId, { cost: r.cost, inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: r.model, status, error: err?.message, errorClass: err?.cls }, now())
    settled = true
  }
  try {
    result = await deps.runner.run(
      {
        purpose: "observe",
        agent: "om-observer",
        system: OBSERVER_SYSTEM,
        prompt: observerPrompt({
          transcript: material.input.text,
          knownContext: knownContext(
            db,
            c.session_id,
            c.project_id,
            db.prepare("SELECT workspace FROM projects WHERE id = ?").get<{ workspace: string }>(c.project_id)?.workspace ?? "personal-knowledge",
          ),
        }),
        schema: OBSERVER_JSON_SCHEMA as unknown as Record<string, unknown>,
        parentSessionId: deps.parentSessionFor?.(c.session_id),
        directory: deps.directoryFor?.(c.project_id),
        model: config.runner.model,
      },
      controller.signal,
    )
    let report: ValidationReport
    try {
      report = validateObserverOutput(result.output, material.input, material.sourceText)
    } catch (e) {
      const err = classifyError(e)
      settle(result, "failed", new RunnerError("invalid_output", err.message))
      return fail(err)
    }
    try {
      const commit = commitObservations(db, claim, report, now())
      settle(result, "succeeded")
      deps.log?.("info", `observed ${c.id}: +${commit.inserted} merged ${commit.merged} dropped ${report.dropped.length}`)
      return { chunkId: c.id, status: "succeeded", commit, dropped: report.dropped.length, tokens: material.input.tokens }
    } catch (e) {
      if (e instanceof StaleLeaseError) {
        settle(result, "stale")
        return { chunkId: c.id, status: "stale" }
      }
      throw e
    }
  } catch (e) {
    const timedOut = controller.signal.aborted && !deps.signal?.aborted
    const err = classifyError(timedOut ? withUsage(new RunnerError("transient", "observer run timed out or lease lost"), e) : e)
    if (!settled) {
      const paid = result ?? usageOfError(e) ?? usageOfError(err)
      settle(paid ?? { cost: 0, inputTokens: 0, outputTokens: 0 }, "failed", err)
    }
    return fail(err)
  } finally {
    clearInterval(renew)
    clearTimeout(timer)
    deps.signal?.removeEventListener("abort", onAbort)
  }
}
