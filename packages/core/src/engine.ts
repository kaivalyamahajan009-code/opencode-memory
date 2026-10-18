import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import { sanitizeConfigPatch, type MemoryConfig } from "./config"
import { openDatabase, type Database } from "./sqlite"
import { migrate } from "./schema-sql"
import { canRead, canRecallSource, canWrite, type AccessContext, type ScopeKind } from "./scope"
import {
  activateBufferChunks,
  cancelOpenChunks,
  contiguousCoverage,
  coverageStats,
  cutChunks,
  observationBacklog,
  releaseOwner,
  retryAllQuarantined,
  retryChunk,
  reviveExcludedChunks,
  type CutReason,
} from "./chunks"
import {
  getSession,
  ingestMessages,
  markRemovedMessages,
  RUNNER_TITLES,
  startedByRunner,
  unchunkedTokens,
  upsertProject,
  upsertSession,
  type ProjectInfo,
} from "./ingest"
import type { OcMessage } from "./normalize"
import { applyObservationDomainHooks, isDomainScope, observeNext, scrubObservationDomain, scrubOutOfScopeDomain, type ObserveOutcome } from "./observer"
import { lastOperationAt, pruneOperations, releaseStaleReservations, recentOperations, usageToday } from "./cost"
import {
  agentReviewReason,
  approveObservation,
  bumpMemoryGeneration,
  editObservation,
  FORGOTTEN_CONTENT,
  suppressionTargetForRow,
  expireObservations,
  getObservation,
  getSources,
  findConflict,
  insertObservation,
  isSuppressed,
  placeObservation,
  subjectKey,
  listObservations,
  listReviewItems,
  observationEvents,
  rejectObservation,
  setPinned,
  supersedeObservation,
  type ListFilter,
  type ObservationRow,
  type Placement,
} from "./observations"
import type { ModelRunner } from "./runner"
import { redact } from "./redact"
import { ALL_KINDS, PayloadSchema, domainOfKind, type Payload } from "./schemas"
import { searchObservations, readableRecent } from "./retrieval"
import { createEmbedder, backfillEmbeddings, pruneOrphanEmbeddings, type Embedder } from "./embeddings"
import { buildMemoryBlock, latestContextSnapshot, memoryGeneration, recordContextSnapshot, type InjectionResult } from "./inject"
import { findForgetCandidates, forgetObservations, forgetSession, inForgetScope, type ForgetResult, type SourcePurge } from "./forget"
import { applyRevert, clearRevert, markSessionDeleted, recordForkLineage, applyForkInheritance, type ForkLineage } from "./lifecycle"
import { listJobs } from "./jobs"
import { approveTopic, listTopics, materializeOutbox, resolveVaultConflict, rollbackTopic, scanExternalEdits, topicGenerations } from "./vault"
import { applyPromotion, dueScopes, reflectScope, type ReflectOutcome } from "./reflector"
import {
  autoBackup,
  backedOffBackups,
  backupNow,
  dueScrub,
  exportJson,
  listBackups,
  markScrubPending,
  markWalTruncate,
  restoreBackup,
  scrubBackups,
  staleBackups,
  truncateWal,
  walTruncatePending,
  type ScrubResult,
  type WatermarkCache,
} from "./backup"
import { captureInlineArtifacts, captureToolArtifacts, listArtifacts } from "./artifacts"
import { dueReviews, listConcepts, reviewCalendar } from "./learning"
import { conflictReport, listClaims, listSources } from "./research"
import { contentHash, estimateTokens, INSTRUCTION_PATTERN, MemoryError, randomId, safeJson, withTimeout, TIMEOUT } from "./util"

export type LogFn = (level: "debug" | "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void

export type SessionMeta = {
  id: string
  parentID?: string
  title?: string
  revertMessageID?: string | null
  fork?: ForkLineage
}

/** One OpenCode instance (directory) inside this process. */
export type InstanceAdapter = {
  id: string
  directory: string
  project: ProjectInfo & { excluded?: boolean }
  runner: ModelRunner
  reflectRunner?: ModelRunner
  fetchMessages(sessionId: string): Promise<OcMessage[]>
  fetchSession?(sessionId: string): Promise<SessionMeta | undefined>
}

export const RECALL_GUARANTEE = "exact recall of retained, redacted source content"

const SKIP_SNAPSHOT_AGENTS = new Set(["title", "summary", "compaction"])

/** Commands that may run a full LLM pass; they return a command id immediately and run in the background. */
const LONG_COMMANDS = new Set(["reflect", "observe"])

export type RecallPart = {
  id: string
  type: string
  tool: string | null
  text: string
  redactions: number
  omitted: number
  forgotten: boolean
  /** The text was cut to fit the recall budget; it contains a "[… N chars omitted …]" marker. */
  truncated?: boolean
}

export type RecallMessage = {
  id: string
  seq: number
  role: string
  agent: string | null
  createdAt: number
  status: string
  parts: RecallPart[]
}

/**
 * Continue a truncated recall by passing these fields back unchanged. Session cursors carry
 * context 0 (padding was already applied before the original start); observation cursors
 * carry the original padding, applied around each remaining cited range, and `observationId`
 * keeps the recall inside those ranges.
 */
export type RecallCursor = { sessionId: string; fromSeq: number; toSeq: number; context: number; observationId?: string }

export type RecallResult =
  | {
      ok: true
      guarantee: string
      sessionId: string
      fromSeq: number
      toSeq: number
      messages: RecallMessage[]
      cited?: [number, number][]
      truncated?: boolean
      nextCursor?: RecallCursor
    }
  | { ok: false; error: string }

const AGENT_INSTRUCTION_REFUSED =
  "instruction-like content is not stored from the agent (it could steer future sessions); the user can add it from the Memory dashboard"

const RECALL_MAX_MESSAGES = 40
const RECALL_MAX_CHARS = 80_000
/** A context-padding message is shown cut to the leftover budget only when at least this much is left. */
const RECALL_MIN_PADDING_CHARS = 1_000

/** Cut a single oversized message to the character budget, marking each shortened part. */
function truncateRecallMessage(m: RecallMessage, budget: number): RecallMessage {
  let left = budget
  const parts = m.parts.map((p) => {
    if (p.text.length <= left) {
      left -= p.text.length
      return p
    }
    const keep = Math.max(0, left)
    left = 0
    return { ...p, text: `${p.text.slice(0, keep)}\n[… ${p.text.length - keep} chars omitted …]`, truncated: true }
  })
  return { ...m, parts }
}

export type RememberInput = {
  content: string
  kind?: string
  scope?: ScopeKind
  actor: "user" | "agent"
  sessionId?: string
  /** Structured fields for the kind (concept, claim, url, key, mastery, …); validated against PayloadSchema. */
  payload?: Record<string, unknown>
}

/** A failed write. `status` is the HTTP-style status a caller should surface (409: forgotten session). */
export type WriteFailure = { ok: false; error: string; status?: 400 | 403 | 404 | 409 }

/** Payload fields that belong to each kind; anything else is dropped from a direct write. */
const PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  preference: ["key", "value"],
  "learning-preference": ["key", "value"],
  "personal-fact": ["key", "value"],
  goal: ["key", "value"],
  "prior-knowledge": ["concept"],
  "quiz-attempt": ["concept", "question", "answer", "evaluation", "hints", "independent", "reviewAt"],
  "retention-check": ["concept", "question", "answer", "evaluation", "hints", "independent", "reviewAt"],
  "demonstrated-skill": ["concept", "question", "answer", "evaluation", "hints", "independent", "mastery"],
  misconception: ["concept"],
  "hint-required": ["concept", "hints"],
  "teaching-intervention": ["concept"],
  "next-review": ["concept", "reviewAt"],
  artifact: ["path", "concept", "title"],
}
const RESEARCH_PAYLOAD = ["claim", "stance", "url", "doi", "title", "publishedAt", "accessedAt", "locator", "quotation", "conditions"] as const

/** Validate a direct-write payload for its kind: known fields only, strings redacted. */
function rememberPayload(kind: string, raw: Record<string, unknown> | undefined): { ok: true; payload: Payload } | WriteFailure {
  if (raw === undefined || raw === null) return { ok: true, payload: {} }
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "payload must be an object", status: 400 }
  const allowed = new Set<string>(PAYLOAD_FIELDS[kind] ?? (domainOfKind(kind) === "research" ? RESEARCH_PAYLOAD : ["key", "value", "concept"]))
  const picked: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || !allowed.has(k)) continue
    picked[k] = typeof v === "string" ? redact(v.trim()).text : v
  }
  const r = PayloadSchema.safeParse(picked)
  if (!r.success) {
    const issue = r.error.issues[0]
    return { ok: false, error: `invalid payload${issue?.path.length ? ` ${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid value"}`, status: 400 }
  }
  const payload: Payload = Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined && v !== "")) as Payload
  if (kind === "quiz-attempt" && payload.hints && payload.hints > 0) payload.independent = false
  return { ok: true, payload }
}

export async function openMemoryDatabase(config: MemoryConfig, path?: string): Promise<Database> {
  mkdirSync(config.dataDir, { recursive: true })
  const db = await openDatabase(path ?? join(config.dataDir, "memory.db"))
  migrate(db)
  return db
}

export class MemoryEngine {
  readonly owner = `${hostname()}:${process.pid}:${randomId("w").slice(2, 10)}`
  private readonly adapters = new Map<string, InstanceAdapter>()
  private readonly draining = new Map<string, Promise<ObserveOutcome[]>>()
  private readonly reflecting = new Map<string, Promise<ReflectOutcome>>()
  private readonly pending = new Map<string, { result: InjectionResult; at: number; requestKey?: string }>()
  private readonly commanding = new Map<number, Promise<void>>()
  private readonly internal = new Map<string, "explicit" | "title" | "agent">()
  private readonly abort = new AbortController()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private embedding: Promise<number> | undefined
  private embedder: Embedder | undefined
  private lastScan = 0
  private lastBackupCheck = 0
  private lastPrune = 0
  private closed = false

  private constructor(
    readonly db: Database,
    public config: MemoryConfig,
    private readonly log: LogFn,
  ) {
    this.embedder = createEmbedder(config.embeddings)
  }

  static async open(config: MemoryConfig, log: LogFn = () => {}, dbPath?: string): Promise<MemoryEngine> {
    const db = await openMemoryDatabase(config, dbPath)
    const engine = new MemoryEngine(db, config, log)
    engine.recover()
    engine.retryBackupScrub()
    return engine
  }

  // ---------- instances ----------

  register(adapter: InstanceAdapter, now = Date.now()) {
    this.adapters.set(adapter.id, adapter)
    upsertProject(this.db, adapter.project, now)
    this.db
      .prepare(
        `INSERT INTO instances(id, pid, directory, project_id, started_at, heartbeat_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
      )
      .run(adapter.id, process.pid, adapter.directory, adapter.project.id, now, now)
    if (!this.timer && !this.closed) {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log("error", `tick crashed: ${String(e)}`)), 15_000)
      ;(this.timer as any).unref?.()
    }
    this.kick(adapter.project.id, now)
  }

  unregister(id: string) {
    this.adapters.delete(id)
    this.db.prepare("DELETE FROM instances WHERE id = ?").run(id)
    if (!this.adapters.size && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  get instanceCount() {
    return this.adapters.size
  }

  adapterForProject(projectId: string): InstanceAdapter | undefined {
    for (const a of this.adapters.values()) if (a.project.id === projectId) return a
  }

  adapterForDirectory(directory: string): InstanceAdapter | undefined {
    const norm = (d: string) => {
      const resolved = resolve(d).replace(/[\\/]+$/, "")
      return process.platform === "win32" ? resolved.toLowerCase() : resolved
    }
    for (const a of this.adapters.values()) if (norm(a.directory) === norm(directory)) return a
  }

  localProjectIds(): string[] {
    return [...new Set([...this.adapters.values()].map((a) => a.project.id))]
  }

  projectRow(projectId: string) {
    return this.db
      .prepare("SELECT id, workspace, domain, name, directory FROM projects WHERE id = ?")
      .get<{ id: string; workspace: string; domain: string | null; name: string | null; directory: string | null }>(projectId)
  }

  context(projectId: string, sessionId?: string): AccessContext {
    return { projectId, workspace: this.projectRow(projectId)?.workspace ?? "personal-knowledge", sessionId }
  }

  contextForSession(sessionId: string): AccessContext | undefined {
    const s = getSession(this.db, sessionId)
    return s ? this.context(s.project_id, sessionId) : undefined
  }

  projectDomain(projectId: string): string {
    return this.projectRow(projectId)?.domain ?? "general"
  }

  // ---------- capture ----------

  /** Explicit marker for a worker session this process created (the runner calls it right after session.create). */
  markInternal(sessionId: string, source: "explicit" | "agent" = "explicit") {
    this.internal.set(sessionId, source)
    this.db.prepare("UPDATE sessions SET internal = 1, internal_source = ? WHERE id = ?").run(source, sessionId)
  }

  isInternal(sessionId: string): boolean {
    if (this.internal.has(sessionId)) return true
    return !!getSession(this.db, sessionId)?.internal
  }

  /**
   * Register a session; internal worker sessions and (by default) subagent sessions are never
   * observed. A session is internal when marked by a runner, titled exactly like a runner
   * session, or (see ingest) opened by a runner agent; a user's own `[memory] …` title is not
   * enough, and a row an older build marked internal for that prefix alone is released.
   */
  trackSession(adapter: InstanceAdapter, meta: SessionMeta, now = Date.now()) {
    const prior = getSession(this.db, meta.id)
    const title = meta.title ?? prior?.title ?? ""
    const remembered = this.internal.get(meta.id)
    const exactTitle = RUNNER_TITLES.has(title)
    const persisted =
      prior?.internal && (prior.internal_source === "explicit" || prior.internal_source === "title" || prior.internal_source === "agent")
        ? prior.internal_source
        : undefined
    const internalSource = remembered ?? (exactTitle ? "title" : persisted)
    const internal = !!internalSource
    if (prior?.internal && !internal && !prior.internal_source && title.startsWith("[memory]") && !RUNNER_TITLES.has(prior.title ?? ""))
      this.db.prepare("UPDATE sessions SET internal = 0, internal_source = NULL, updated_at = ? WHERE id = ?").run(now, meta.id)
    const subagent = !!meta.parentID && !this.config.capture.observeSubagents
    upsertSession(
      this.db,
      {
        id: meta.id,
        projectId: adapter.project.id,
        parentId: meta.parentID,
        title: meta.title,
        internal,
        internalSource,
        excluded: !!adapter.project.excluded || subagent,
      },
      now,
    )
    if (internalSource) this.internal.set(meta.id, internalSource)
    else this.internal.delete(meta.id)
    if (meta.fork && !getSession(this.db, meta.id)?.fork_source) this.onFork(meta.id, meta.fork, now)
  }

  /** Snapshot the session's completed messages; `full` means the list is the whole session (enables removal detection). */
  ingest(sessionId: string, messages: OcMessage[], opts: { full?: boolean; now?: number } = {}) {
    const s = getSession(this.db, sessionId)
    if (!s || s.internal || s.excluded || s.paused || s.deleted_at || this.sessionForgotten(sessionId)) return undefined
    if (!this.db.prepare("SELECT 1 FROM source_messages WHERE session_id = ? LIMIT 1").get(sessionId) && startedByRunner(messages)) {
      this.markInternal(sessionId, "agent")
      return undefined
    }
    const r = ingestMessages(this.db, sessionId, messages, {
      captureReasoning: this.config.capture.captureReasoning,
      toolOutputMax: this.config.capture.snapshotToolOutputMax,
      staleIncompleteMs: this.config.capture.staleIncompleteMs,
      stopAt: s.revert_message_id,
      now: opts.now,
    })
    if (opts.full) markRemovedMessages(this.db, sessionId, new Set(messages.map((m) => m.info.id)))
    if (s.fork_source && r.captured) applyForkInheritance(this.db, sessionId, opts.now)
    this.scheduleCuts(sessionId, opts.now)
    return r
  }

  /** Fetch from OpenCode and ingest. */
  async sync(adapter: InstanceAdapter, sessionId: string) {
    if (this.isInternal(sessionId)) return undefined
    const messages = await adapter.fetchMessages(sessionId)
    return this.ingest(sessionId, messages, { full: true })
  }

  /** Promote buffer chunks whose session crossed activation or became stale/idle. */
  private activateReadyBuffers(projectIds: string[] | undefined, now: number, recovery = false): number {
    const filter = projectIds?.length ? `AND c.project_id IN (${projectIds.map(() => "?").join(",")})` : ""
    const rows = this.db
      .prepare(
        `SELECT c.session_id, s.last_activity_at, MIN(c.created_at) AS oldest_buffer_at
         FROM chunks c JOIN sessions s ON s.id = c.session_id
         WHERE c.reason = 'buffer' AND c.state IN ('pending','retryable','running')
         AND s.excluded = 0 AND s.internal = 0 AND s.paused = 0 AND s.deleted_at IS NULL
         ${filter}
         GROUP BY c.session_id, s.last_activity_at`,
      )
      .all<{ session_id: string; last_activity_at: number | null; oldest_buffer_at: number }>(...(projectIds ?? []))
    const o = this.config.observe
    let activated = 0
    for (const row of rows) {
      const backlog = observationBacklog(this.db, row.session_id)
      const threshold = o.activationTokens === 0 || backlog.totalTokens >= o.activationTokens
      const aged = now - row.oldest_buffer_at >= o.maxUnobservedAgeMs
      const idle = row.last_activity_at != null && now - row.last_activity_at >= o.idleFlushMs
      if (!threshold && !aged && !idle) continue
      const reason = threshold ? "activation" : recovery ? "recovery" : aged ? "age" : "idle"
      activated += activateBufferChunks(this.db, row.session_id, reason, now)
    }
    return activated
  }

  /** Token threshold, maximum age, or idle: cut chunks and wake the observer when ready. */
  scheduleCuts(sessionId: string, now = Date.now()): { reason: CutReason; chunks: string[] } | undefined {
    const o = this.config.observe
    const u = unchunkedTokens(this.db, sessionId)
    if (!u.count) return undefined
    const opts = { bufferTokens: o.bufferTokens, maxChunkTokens: o.maxChunkTokens, minFlushTokens: o.minFlushTokens, now }
    let decision: { reason: CutReason; chunks: string[] } | undefined
    if (u.tokens >= o.bufferTokens) decision = { reason: "buffer", chunks: cutChunks(this.db, sessionId, "buffer", opts) }
    else if (u.oldest !== null && now - u.oldest >= o.maxUnobservedAgeMs) decision = { reason: "age", chunks: cutChunks(this.db, sessionId, "age", opts) }
    else {
      const s = getSession(this.db, sessionId)
      if (s?.last_activity_at && now - s.last_activity_at >= o.idleFlushMs) decision = { reason: "idle", chunks: cutChunks(this.db, sessionId, "idle", opts) }
    }
    if (!decision) {
      const backlog = observationBacklog(this.db, sessionId)
      if (o.activationTokens === 0 || backlog.totalTokens >= o.activationTokens) {
        const activated = activateBufferChunks(this.db, sessionId, "activation", now)
        const s = getSession(this.db, sessionId)
        if (activated && s) this.kick(s.project_id, now)
      }
      return undefined
    }
    const s = getSession(this.db, sessionId)
    let activated = 0
    if (decision.reason === "buffer") {
      const backlog = observationBacklog(this.db, sessionId)
      if (o.activationTokens === 0 || backlog.totalTokens >= o.activationTokens)
        activated = activateBufferChunks(this.db, sessionId, "activation", now)
    } else {
      activated = activateBufferChunks(this.db, sessionId, decision.reason, now)
    }
    if (s && (decision.reason !== "buffer" ? decision.chunks.length > 0 || activated > 0 : activated > 0))
      this.kick(s.project_id, now)
    return decision.chunks.length || activated ? decision : undefined
  }

  /** Observe everything captured so far for a session. With wait, resolves after the observer drained it (bounded). */
  async flush(sessionId: string, opts: { wait?: boolean; timeoutMs?: number } = {}) {
    const o = this.config.observe
    const s = getSession(this.db, sessionId)
    if (!s) return { chunks: [] as string[], outcomes: [] as ObserveOutcome[], waited: false }
    const adapter = this.adapterForProject(s.project_id)
    if (adapter) await this.sync(adapter, sessionId).catch((e) => this.log("warn", `flush sync failed: ${String(e)}`))
    const chunks = cutChunks(this.db, sessionId, "explicit", { bufferTokens: o.bufferTokens, maxChunkTokens: o.maxChunkTokens, minFlushTokens: o.minFlushTokens })
    activateBufferChunks(this.db, sessionId, "explicit")
    if (!opts.wait || !adapter) {
      this.kick(s.project_id)
      return { chunks, outcomes: [] as ObserveOutcome[], waited: false }
    }
    const r = await withTimeout(this.drainReady(s.project_id), opts.timeoutMs ?? this.config.runner.timeoutMs)
    return { chunks, outcomes: r === TIMEOUT ? [] : r, waited: r !== TIMEOUT }
  }

  recover(now = Date.now()) {
    const reservations = releaseStaleReservations(this.db, 60 * 60_000, now)
    const o = this.config.observe
    const rows = this.db
      .prepare(
        `SELECT i.session_id, s.last_activity_at FROM ingest_state i JOIN sessions s ON s.id = i.session_id
         WHERE i.last_seq > i.chunked_seq AND s.excluded = 0 AND s.internal = 0 AND s.paused = 0 AND s.deleted_at IS NULL`,
      )
      .all<{ session_id: string; last_activity_at: number | null }>()
    let chunks = 0
    let activated = 0
    for (const r of rows) {
      if (r.last_activity_at && now - r.last_activity_at < o.idleFlushMs) continue
      chunks += cutChunks(this.db, r.session_id, "recovery", { bufferTokens: o.bufferTokens, maxChunkTokens: o.maxChunkTokens, minFlushTokens: o.minFlushTokens, now }).length
      activated += activateBufferChunks(this.db, r.session_id, "recovery", now)
    }
    activated += this.activateReadyBuffers(undefined, now, true)
    expireObservations(this.db, now)
    try {
      scrubOutOfScopeDomain(this.db, now)
      pruneOperations(this.db, now)
    } catch (e) {
      this.log("warn", `maintenance on open failed: ${String(e)}`)
    }
    return { sessions: rows.length, chunks, activated, reservations }
  }

  // ---------- workers ----------

  get paused(): boolean {
    const r = this.db.prepare("SELECT value, until FROM runtime_state WHERE key = 'paused'").get<{ value: string; until: number | null }>()
    if (!r || r.value !== "1") return false
    return !r.until || r.until > Date.now()
  }

  /** Why observation is paused ('manual', 'auth', ...), or null when it is not paused right now. */
  pausedReason(now = Date.now()): string | null {
    if (!this.paused) return null
    const r = this.db.prepare("SELECT value, until FROM runtime_state WHERE key = 'paused_reason'").get<{ value: string; until: number | null }>()
    return r && (!r.until || r.until > now) ? r.value : "manual"
  }

  /** Manual pause/resume. Resume also lifts the auth backoff on chunks parked by an auth failure and wakes the observer. */
  setPaused(paused: boolean, untilMs?: number) {
    const now = Date.now()
    this.db.tx(() => {
      bumpMemoryGeneration(this.db)
      this.db
        .prepare("INSERT OR REPLACE INTO runtime_state(key, value, until, updated_at) VALUES ('paused', ?, ?, ?)")
        .run(paused ? "1" : "0", untilMs ?? null, now)
      if (paused) {
        this.db
          .prepare("INSERT OR REPLACE INTO runtime_state(key, value, until, updated_at) VALUES ('paused_reason', 'manual', ?, ?)")
          .run(untilMs ?? null, now)
        return
      }
      this.db.prepare("DELETE FROM runtime_state WHERE key IN ('paused_reason','auth_strikes')").run()
      this.db
        .prepare("UPDATE chunks SET next_attempt_at = NULL, updated_at = ? WHERE error_class = 'auth' AND state IN ('pending','retryable')")
        .run(now)
    })
    if (!paused) for (const p of this.localProjectIds()) this.kick(p)
  }

  /**
   * Excluding cancels open chunks; un-excluding revives them (except forgotten ranges) so no
   * permanent gap is left. A forgotten session stays excluded: un-excluding it throws
   * MemoryError('forgotten', 409).
   */
  setSessionFlag(sessionId: string, flag: "paused" | "excluded", value: boolean) {
    const now = Date.now()
    if (flag === "excluded" && !value && this.sessionForgotten(sessionId))
      throw new MemoryError("this session was forgotten and cannot be included in memory again", "forgotten", 409)
    const revived = this.db.tx(() => {
      this.db.prepare(`UPDATE sessions SET ${flag} = ?, updated_at = ? WHERE id = ?`).run(value ? 1 : 0, now, sessionId)
      bumpMemoryGeneration(this.db)
      if (flag !== "excluded") return 0
      if (value) {
        cancelOpenChunks(this.db, sessionId, { reason: "exclude", now })
        return 0
      }
      return reviveExcludedChunks(this.db, sessionId, now)
    })
    const s = getSession(this.db, sessionId)
    if (revived && s) this.kick(s.project_id)
  }

  /** The user forgot this whole session (a session suppression exists). */
  sessionForgotten(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM suppressions WHERE kind = 'session' AND value = ?").get(sessionId)
  }

  /** Why nothing may be written for this session (forgotten, excluded or deleted), or undefined. */
  private sessionWriteBlock(sessionId: string | null | undefined): WriteFailure | undefined {
    if (!sessionId) return undefined
    if (this.sessionForgotten(sessionId)) return { ok: false, error: "this session was forgotten; nothing more is stored from it", status: 409 }
    const s = getSession(this.db, sessionId)
    if (s?.deleted_at != null) return { ok: false, error: "this session was deleted; memories cannot be written to it", status: 409 }
    if (s?.excluded) return { ok: false, error: "this session is excluded from memory; memories cannot be written to it", status: 409 }
    return undefined
  }

  kick(projectId?: string, now = Date.now()) {
    if (this.closed) return
    const ids = projectId ? [projectId] : this.localProjectIds()
    this.activateReadyBuffers(ids, now)
    for (const id of ids) {
      if (!this.adapterForProject(id) || this.draining.has(id)) continue
      const t = setTimeout(() => void this.drainReady(id).catch((e) => this.log("error", `drain ${id} crashed: ${String(e)}`)), 0)
      t.unref?.()
    }
  }

  /** Explicit/manual drain: activate every buffered chunk in the project before claiming. */
  drain(projectId: string, max = 25): Promise<ObserveOutcome[]> {
    this.db
      .prepare(
        `UPDATE chunks SET reason = 'buffer:manual', updated_at = ?
         WHERE project_id = ? AND reason = 'buffer' AND state IN ('pending','retryable','running')`,
      )
      .run(Date.now(), projectId)
    return this.drainReady(projectId, max)
  }

  /** Single-flight observation loop for ready work in one project. */
  private drainReady(projectId: string, max = 25): Promise<ObserveOutcome[]> {
    const running = this.draining.get(projectId)
    if (running) return running
    const adapter = this.adapterForProject(projectId)
    if (!adapter || this.paused) return Promise.resolve([])
    const p = (async () => {
      const out: ObserveOutcome[] = []
      try {
        for (let i = 0; i < max; i++) {
          if (this.abort.signal.aborted || this.paused) break
          const r = await observeNext({
            db: this.db,
            config: this.config,
            runner: adapter.runner,
            owner: this.owner,
            projectIds: [projectId],
            includeInactiveBuffer: false,
            parentSessionFor: (sid) => sid,
            directoryFor: () => adapter.directory,
            signal: this.abort.signal,
            log: (level, msg, extra) => this.log(level, msg, extra),
          })
          if (!r) break
          out.push(r)
          if (r.status === "paused") break
        }
      } finally {
        this.draining.delete(projectId)
      }
      if (out.length >= max) this.kick(projectId)
      return out
    })()
    this.draining.set(projectId, p)
    return p
  }

  get busy(): boolean {
    return this.draining.size > 0
  }

  scopeKeysFor(projectIds: string[]): string[] {
    const keys = new Set<string>()
    for (const p of projectIds) {
      keys.add(`project:${p}`)
      const ws = this.projectRow(p)?.workspace
      if (ws) keys.add(`workspace:${ws}`)
    }
    return [...keys]
  }

  reflectNow(key: string): Promise<ReflectOutcome> {
    const running = this.reflecting.get(key)
    if (running) return running
    const projectId = key.startsWith("project:") ? key.slice("project:".length) : undefined
    const adapter =
      (projectId && this.adapterForProject(projectId)) ||
      [...this.adapters.values()].find((a) => `workspace:${a.project.workspace}` === key) ||
      [...this.adapters.values()][0]
    if (!adapter) return Promise.resolve({ status: "failed", error: "no OpenCode instance available to run the reflector", cls: "transient" })
    const p = reflectScope(
      {
        db: this.db,
        config: this.config,
        runner: adapter.reflectRunner ?? adapter.runner,
        owner: this.owner,
        directory: adapter.directory,
        signal: this.abort.signal,
        log: (level, msg) => this.log(level, msg),
      },
      key,
    ).finally(() => this.reflecting.delete(key))
    this.reflecting.set(key, p)
    return p
  }

  reflectDue() {
    if (this.paused) return []
    const due = dueScopes(this.db, this.config.reflect, this.scopeKeysFor(this.localProjectIds()))
    for (const key of due) void this.reflectNow(key).catch((e) => this.log("error", `reflect ${key} failed: ${String(e)}`))
    return due
  }

  private backfill() {
    if (!this.embedder || this.embedding) return
    this.embedding = backfillEmbeddings(this.db, this.embedder, { batchSize: this.config.embeddings.batchSize, max: 256, signal: this.abort.signal })
      .catch((e) => {
        this.log("warn", `embedding backfill failed: ${String(e)}`)
        return 0
      })
      .finally(() => (this.embedding = undefined))
  }

  /** Periodic maintenance: heartbeat, cuts, expiry, vault, backups, embeddings, observation, reflection, routed commands. */
  async tick(now = Date.now()) {
    if (this.ticking || this.closed) return
    this.ticking = true
    try {
      for (const a of this.adapters.values()) this.db.prepare("UPDATE instances SET heartbeat_at = ? WHERE id = ?").run(now, a.id)
      this.db.prepare("DELETE FROM instances WHERE heartbeat_at < ?").run(now - 120_000)
      const local = this.localProjectIds()
      if (local.length) {
        const sessions = this.db
          .prepare(
            `SELECT s.id FROM sessions s JOIN ingest_state i ON i.session_id = s.id
             WHERE s.project_id IN (${local.map(() => "?").join(",")}) AND i.last_seq > i.chunked_seq
             AND s.excluded = 0 AND s.internal = 0 AND s.paused = 0 AND s.deleted_at IS NULL`,
          )
          .all<{ id: string }>(...local)
        for (const s of sessions) this.scheduleCuts(s.id, now)
      }
      expireObservations(this.db, now)
      try {
        materializeOutbox(this.db, this.config.vaultDir, this.owner, now)
        if (now - this.lastScan > 5 * 60_000) {
          this.lastScan = now
          scanExternalEdits(this.db, this.config.vaultDir, now)
        }
      } catch (e) {
        this.log("warn", `vault write failed: ${String(e)}`)
      }
      if (now - this.lastPrune > 60 * 60_000) {
        this.lastPrune = now
        pruneOperations(this.db, now)
      }
      if (this.config.backup.autoDaily && now - this.lastBackupCheck > 60 * 60_000) {
        this.lastBackupCheck = now
        try {
          autoBackup(this.db, this.config.dataDir, this.config.backup.keep, now)
        } catch (e) {
          this.log("warn", `backup failed: ${String(e)}`)
        }
      }
      for (const [sid, p] of this.pending) if (now - p.at > 10 * 60_000) this.pending.delete(sid)
      this.retryBackupScrub(now)
      this.backfill()
      this.kick(undefined, now)
      this.reflectDue()
      void this.processCommands(now).catch((e) => this.log("error", `processCommands failed: ${String(e)}`))
    } catch (e) {
      this.log("error", `tick failed: ${String(e)}`)
    } finally {
      this.ticking = false
    }
  }

  // ---------- command routing ----------

  /**
   * Dashboard actions that need an OpenCode instance (a runner) go to the instance
   * owning the directory. Local instances execute directly; others pick the
   * command up from the shared database on their next tick.
   */
  async routeCommand(directory: string, kind: string, payload: Record<string, unknown>) {
    const local = this.adapterForDirectory(directory)
    const now = Date.now()
    if (local && !LONG_COMMANDS.has(kind)) return { routed: false, result: await this.executeCommand(kind, payload) }
    if (local) {
      const id = this.insertCommand(directory, kind, payload, "running", now)
      this.runCommand(id, kind, payload)
      return { routed: false, commandId: id, state: "running" as const }
    }
    const id = this.insertCommand(directory, kind, payload, "pending", now)
    return { routed: true, commandId: id, state: "pending" as const }
  }

  commandStatus(id: number) {
    return this.db.prepare("SELECT id, kind, state, result, attempts, created_at, updated_at FROM commands WHERE id = ?").get<any>(id)
  }

  private get commandLeaseMs() {
    return this.config.runner.timeoutMs + 60_000
  }

  private insertCommand(directory: string, kind: string, payload: Record<string, unknown>, state: "pending" | "running", now: number): number {
    const running = state === "running"
    return this.db.tx(() => {
      this.db
        .prepare("INSERT INTO commands(directory, kind, payload, state, owner, lease_expires_at, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(directory, kind, JSON.stringify(payload), state, running ? this.owner : null, running ? now + this.commandLeaseMs : null, running ? 1 : 0, now, now)
      return this.db.prepare("SELECT last_insert_rowid() AS id").get<{ id: number }>()!.id
    })
  }

  /** Run a claimed command in the background; completion only lands while this process still owns it. */
  private runCommand(id: number, kind: string, payload: Record<string, any>) {
    const finish = (state: "done" | "failed", result: unknown) =>
      this.db
        .prepare("UPDATE commands SET state = ?, result = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND owner = ? AND state = 'running'")
        .run(state, JSON.stringify(result ?? null), Date.now(), id, this.owner)
    const run = this.executeCommand(kind, payload)
      .then((result) => void finish("done", result))
      .catch((e) => {
        this.log("error", `command ${id} ${kind} failed: ${String(e)}`)
        finish("failed", { error: String(e) })
      })
      .finally(() => this.commanding.delete(id))
    this.commanding.set(id, run)
  }

  /**
   * Routed-command upkeep and pickup: renew leases of our running commands, reclaim
   * stale running ones (re-pend once, then fail), expire rows pending for over an hour
   * since they were queued or re-queued, delete finished rows older than a day, then
   * claim pending rows for local directories (oldest first) and run them in the background.
   */
  async processCommands(now = Date.now()) {
    const lease = this.commandLeaseMs
    const mine = [...this.commanding.keys()]
    if (mine.length)
      this.db
        .prepare(`UPDATE commands SET lease_expires_at = ?, updated_at = ? WHERE owner = ? AND state = 'running' AND id IN (${mine.map(() => "?").join(",")})`)
        .run(now + lease, now, this.owner, ...mine)
    const stale = "state = 'running' AND COALESCE(lease_expires_at, updated_at + ?) < ?"
    this.db
      .prepare(`UPDATE commands SET state = 'pending', owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE ${stale} AND attempts < 2`)
      .run(now, lease, now)
    this.db
      .prepare(`UPDATE commands SET state = 'failed', result = ?, owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE ${stale}`)
      .run(JSON.stringify({ error: "command lease expired (instance stopped while running it)" }), now, lease, now)
    this.db
      .prepare("UPDATE commands SET state = 'expired', updated_at = ? WHERE state = 'pending' AND updated_at <= ?")
      .run(now, now - 3_600_000)
    this.db.prepare("DELETE FROM commands WHERE state IN ('done','failed','expired') AND updated_at < ?").run(now - 86_400_000)

    if (!this.adapters.size) return 0
    const local = this.db
      .prepare("SELECT DISTINCT directory FROM commands WHERE state = 'pending'")
      .all<{ directory: string }>()
      .map((r) => r.directory)
      .filter((d) => this.adapterForDirectory(d))
    if (!local.length) return 0
    const rows = this.db
      .prepare(`SELECT id, directory, kind, payload FROM commands WHERE state = 'pending' AND directory IN (${local.map(() => "?").join(",")}) ORDER BY id LIMIT 20`)
      .all<{ id: number; directory: string; kind: string; payload: string }>(...local)
    let claimed = 0
    for (const r of rows) {
      if (this.commanding.has(r.id)) continue
      const took = this.db
        .prepare(
          "UPDATE commands SET state = 'running', owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'pending'",
        )
        .run(this.owner, now + lease, now, r.id).changes
      if (!took) continue
      claimed++
      this.runCommand(r.id, r.kind, safeJson(r.payload, {}))
    }
    return claimed
  }

  async executeCommand(kind: string, payload: Record<string, any>): Promise<unknown> {
    switch (kind) {
      case "flush":
        return this.flush(String(payload.sessionId), {
          wait: payload.wait === true,
          timeoutMs: typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined,
        })
      case "reflect":
        return this.reflectNow(String(payload.scopeKey))
      case "observe": {
        const outcomes = await Promise.all(this.localProjectIds().map((p) => this.drain(p)))
        return { observed: outcomes.reduce((n, o) => n + o.length, 0) }
      }
      default:
        throw new Error(`unknown command ${kind}`)
    }
  }

  // ---------- injection ----------

  /**
   * Build the memory block for a real user turn. Never throws; returns undefined when nothing should be injected.
   * `override` replaces the project domain and the workspace used for this block only.
   */
  async buildInjection(
    sessionId: string,
    query?: string,
    requestKey?: string,
    override?: { domain?: string; workspace?: string },
  ): Promise<InjectionResult | undefined> {
    try {
      if (!this.config.inject.enabled || this.isInternal(sessionId)) {
        this.pending.delete(sessionId)
        return undefined
      }
      const s = getSession(this.db, sessionId)
      if (!s || s.excluded) {
        this.pending.delete(sessionId)
        return undefined
      }
      const started = Date.now()
      const deadline = this.config.inject.deadlineMs
      let queryVector: Float32Array | undefined
      if (this.embedder && query?.trim()) {
        const v = await withTimeout(this.embedder.embed([query.slice(0, 2000)]), Math.max(50, Math.floor(deadline / 2))).catch(() => TIMEOUT)
        if (v !== TIMEOUT && Array.isArray(v)) queryVector = v[0]
      }
      const ctx = {
        ...this.context(s.project_id),
        sessionId,
        ...(override?.workspace ? { workspace: override.workspace } : {}),
      }
      const result = buildMemoryBlock(this.db, {
        ctx,
        domain: override?.domain || this.projectDomain(s.project_id),
        query,
        queryVector,
        embeddingModel: this.embedder?.model,
        budget: this.config.inject.budget,
      })
      const took = Date.now() - started
      if (took > deadline) this.log("warn", `memory injection took ${took}ms (deadline ${deadline}ms)`)
      this.pending.set(sessionId, { result, at: Date.now(), requestKey })
      return result
    } catch (e) {
      this.log("warn", `buildInjection failed: ${String(e)}`)
      this.pending.delete(sessionId)
      return undefined
    }
  }

  /**
   * Re-key the pending (built, not yet committed) block from one request key (user message id)
   * to another, e.g. when chat.params reports a different message id than chat.message did.
   * Returns false when nothing is pending for that session under `fromKey`.
   */
  rekeyInjection(sessionId: string, fromKey: string, toKey: string): boolean {
    const p = this.pending.get(sessionId)
    if (!p || (p.requestKey != null && p.requestKey !== fromKey)) return false
    p.requestKey = toKey
    return true
  }

  /** DB-backed counter behind injection invalidation (see memoryGeneration() in inject.ts); shared by every process on this database. */
  memoryGeneration(): number {
    return memoryGeneration(this.db)
  }

  /** Persist the block that was actually sent, once per user message, for real turns only. */
  commitInjection(sessionId: string, requestKey: string, agent?: string, model?: string) {
    try {
      const p = this.pending.get(sessionId)
      if (!p || !p.result.block) return undefined
      if (p.requestKey != null && p.requestKey !== requestKey) return undefined
      if (agent && (agent.startsWith("om-") || SKIP_SNAPSHOT_AGENTS.has(agent))) return undefined
      const last = latestContextSnapshot(this.db, sessionId)
      if (last && last.request_key === requestKey && last.block === p.result.block) {
        this.pending.delete(sessionId)
        return last.id
      }
      const id = randomId("ctx")
      this.pending.delete(sessionId)
      return recordContextSnapshot(this.db, { id, sessionId, requestKey, agent, model, result: p.result })
    } catch (e) {
      this.log("warn", `commitInjection failed: ${String(e)}`)
      return undefined
    }
  }

  latestSnapshot(sessionId: string) {
    const s = latestContextSnapshot(this.db, sessionId)
    if (!s) return undefined
    return { ...s, observation_ids: safeJson<string[]>(s.observation_ids, []) }
  }

  snapshots(sessionId: string, limit = 30) {
    return this.db
      .prepare("SELECT id, request_key, agent, model, memory_generation, token_est, created_at FROM context_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all<any>(sessionId, limit)
  }

  // ---------- reads ----------

  search(ctx: AccessContext, query: string, opts: { kinds?: string[]; scopes?: ScopeKind[]; includeHistory?: boolean; limit?: number } = {}) {
    return searchObservations(this.db, { query, ctx, ...opts })
  }

  /** Reads through the central scope policy. */
  list(ctx: AccessContext, filter: { scopes?: ScopeKind[]; kinds?: string[]; limit?: number } = {}) {
    return readableRecent(this.db, ctx, filter)
  }

  /** Dashboard view of everything (the dashboard is the user's own UI). */
  listAll(filter: ListFilter & { query?: string }) {
    if (filter.query?.trim()) {
      const like = `%${filter.query.trim().replace(/[%_]/g, "")}%`
      return listObservations(this.db, filter, { sql: "o.content LIKE ?", params: [like] })
    }
    return listObservations(this.db, filter)
  }

  observation(id: string, ctx?: AccessContext) {
    const row = getObservation(this.db, id)
    if (!row) return undefined
    if (ctx && !canRead(ctx, row)) return undefined
    return {
      ...row,
      payload: safeJson<Record<string, unknown>>(row.payload, {}),
      sources: getSources(this.db, id).map((s) => ({ ...s, part_ids: safeJson<string[]>(s.part_ids, []) })),
      events: observationEvents(this.db, id).map((e: any) => ({ ...e, data: safeJson(e.data, null) })),
      reviews: this.db.prepare("SELECT * FROM review_items WHERE ref_id = ? ORDER BY created_at DESC").all<any>(id),
    }
  }

  private recallMessages(sessionId: string, fromSeq: number, toSeq: number, limit = RECALL_MAX_MESSAGES + 1): RecallMessage[] {
    const msgs = this.db
      .prepare("SELECT id, seq, role, agent, created_at, status FROM source_messages WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq LIMIT ?")
      .all<{ id: string; seq: number; role: string; agent: string | null; created_at: number; status: string }>(sessionId, fromSeq, toSeq, limit)
    const partsQ = this.db.prepare("SELECT id, type, tool, text, redactions, omitted, suppressed FROM source_parts WHERE message_id = ? ORDER BY ord")
    return msgs.map((m) => ({
      id: m.id,
      seq: m.seq,
      role: m.role,
      agent: m.agent,
      createdAt: m.created_at,
      status: m.status,
      parts: partsQ
        .all<{ id: string; type: string; tool: string | null; text: string; redactions: number; omitted: number; suppressed: number }>(m.id)
        .map((p) => ({ id: p.id, type: p.type, tool: p.tool, text: p.text, redactions: p.redactions, omitted: p.omitted, forgotten: !!p.suppressed })),
    }))
  }

  /**
   * Fit messages into one page (≤40 messages, ≤80k chars). The anchor (first message at or
   * after `anchorSeq`) is always included, cut with an omission marker when it alone exceeds
   * the budget, so every cursor lies strictly after the requested start. Messages after the
   * anchor come next; context padding before it only gets the budget that is left.
   */
  private capRecall(messages: RecallMessage[], anchorSeq?: number): { messages: RecallMessage[]; truncated: boolean; stoppedAt?: number } {
    const size = (m: RecallMessage) => m.parts.reduce((n, p) => n + p.text.length, 0)
    const found = anchorSeq === undefined ? 0 : messages.findIndex((m) => m.seq >= anchorSeq)
    const anchor = found < 0 ? messages.length : found
    const after: RecallMessage[] = []
    let chars = 0
    let truncated = false
    let stoppedAt: number | undefined
    for (let i = anchor; i < messages.length; i++) {
      const m = messages[i]!
      const s = size(m)
      if (after.length && (after.length >= RECALL_MAX_MESSAGES || chars + s > RECALL_MAX_CHARS)) {
        stoppedAt = m.seq
        truncated = true
        break
      }
      if (s > RECALL_MAX_CHARS) {
        after.push(truncateRecallMessage(m, RECALL_MAX_CHARS))
        chars = RECALL_MAX_CHARS
        truncated = true
        continue
      }
      after.push(m)
      chars += s
    }
    const before: RecallMessage[] = []
    for (let i = anchor - 1; i >= 0; i--) {
      const m = messages[i]!
      const s = size(m)
      if (after.length + before.length >= RECALL_MAX_MESSAGES) {
        truncated = true
        break
      }
      if (chars + s > RECALL_MAX_CHARS) {
        const left = RECALL_MAX_CHARS - chars
        if (!before.length && left >= RECALL_MIN_PADDING_CHARS) before.unshift(truncateRecallMessage(m, left))
        truncated = true
        break
      }
      before.unshift(m)
      chars += s
    }
    return { messages: [...before, ...after], truncated, stoppedAt }
  }

  /**
   * Exact recall of the retained, redacted snapshot behind an observation or a session range.
   * Pages are bounded; pass `nextCursor` back unchanged to read the rest. A page always
   * contains the first message at or after the requested fromSeq, so cursors strictly advance
   * whatever context is passed. Session cursors carry context 0 (padding only precedes the
   * original start); observation cursors keep the original padding around each later cited
   * range, never before the continuation point.
   */
  recallSource(
    ctx: AccessContext,
    q: { observationId?: string; sessionId?: string; fromSeq?: number; toSeq?: number; context?: number },
  ): RecallResult {
    const pad = Math.max(0, Math.min(10, Math.floor(q.context ?? 1)))
    const done = (
      sessionId: string,
      windows: [number, number][],
      anchorSeq: number | undefined,
      cited?: [number, number][],
      observationId?: string,
    ): RecallResult => {
      const collected: RecallMessage[] = []
      const fetchMax = RECALL_MAX_MESSAGES + 1 + 2 * pad
      for (const [lo, hi] of windows) {
        if (collected.length >= fetchMax) break
        collected.push(...this.recallMessages(sessionId, lo, hi, fetchMax - collected.length))
      }
      const end = windows.length ? windows[windows.length - 1]![1] : 0
      const capped = this.capRecall(collected, anchorSeq)
      const nextCursor: RecallCursor | undefined =
        capped.stoppedAt !== undefined
          ? observationId
            ? { sessionId, fromSeq: capped.stoppedAt, toSeq: end, context: pad, observationId }
            : { sessionId, fromSeq: capped.stoppedAt, toSeq: end, context: 0 }
          : undefined
      const truncated = capped.truncated || !!nextCursor
      const fromSeq = capped.messages[0]?.seq ?? windows[0]?.[0] ?? 1
      const toSeq = capped.messages[capped.messages.length - 1]?.seq ?? end
      const shown = cited?.filter(([a, b]) => a <= toSeq && b >= fromSeq)
      return {
        ok: true,
        guarantee: truncated ? `${RECALL_GUARANTEE} (truncated)` : RECALL_GUARANTEE,
        sessionId,
        fromSeq,
        toSeq,
        messages: capped.messages,
        ...(cited ? { cited: shown?.length ? shown : cited } : {}),
        truncated,
        nextCursor,
      }
    }
    if (q.observationId) {
      const row = getObservation(this.db, q.observationId)
      if (!row || !canRead(ctx, row)) return { ok: false, error: "observation not found or not readable from this project" }
      const sources = getSources(this.db, row.id)
      if (!sources.length) return { ok: false, error: "this observation has no recorded source (it was written directly)" }
      const s = sources.find((x) => this.sourceReadable(ctx, x.session_id, row)) ?? undefined
      if (!s) return { ok: false, error: "the source conversation belongs to a project you cannot read from here" }
      const cited = sources.filter((x) => x.session_id === s.session_id).map((x) => [x.start_seq, x.end_seq] as [number, number])
      cited.sort((a, b) => a[0] - b[0])
      let windows: [number, number][] = []
      for (const [a, b] of cited) {
        const w: [number, number] = [Math.max(1, a - pad), b + pad]
        const prev = windows[windows.length - 1]
        if (prev && w[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], w[1])
        else windows.push(w)
      }
      const from = q.fromSeq
      const to = q.toSeq
      if (from !== undefined) windows = windows.filter((w) => w[1] >= from).map((w) => [Math.max(w[0], from), w[1]])
      if (to !== undefined) windows = windows.filter((w) => w[0] <= to).map((w) => [w[0], Math.min(w[1], to)])
      return done(s.session_id, windows, from ?? cited[0]?.[0], cited, row.id)
    }
    if (!q.sessionId) return { ok: false, error: "give an observation id or a session id" }
    if (!this.sourceReadable(ctx, q.sessionId)) return { ok: false, error: "that session is not readable from this project" }
    const start = Math.max(1, q.fromSeq ?? 1)
    const lo = Math.max(1, start - pad)
    const hi = Math.max(start, (q.toSeq ?? start) + pad)
    return done(q.sessionId, [[lo, hi]], start)
  }

  private sourceReadable(ctx: AccessContext, sessionId: string, via?: ObservationRow): boolean {
    const s = getSession(this.db, sessionId)
    if (!s) return false
    const workspace = this.projectRow(s.project_id)?.workspace ?? ""
    return canRecallSource(ctx, { projectId: s.project_id, workspace }, via)
  }

  sessionStatus(sessionId: string) {
    const db = this.db
    const u = unchunkedTokens(db, sessionId)
    const backlog = observationBacklog(db, sessionId)
    const ingest = db.prepare("SELECT last_seq, chunked_seq FROM ingest_state WHERE session_id = ?").get<{ last_seq: number; chunked_seq: number }>(sessionId)
    const chunks = coverageStats(db, sessionId)
    const obs = db
      .prepare(
        `SELECT COUNT(DISTINCT o.id) AS n, COALESCE(SUM(o.token_est),0) AS t FROM observations o
         WHERE o.status IN ('active','pending_review') AND o.visibility = 'visible'
         AND EXISTS (SELECT 1 FROM observation_sources s WHERE s.observation_id = o.id AND s.session_id = ?)`,
      )
      .get<{ n: number; t: number }>(sessionId)!
    const state = db
      .prepare("SELECT current_task, suggested_next, updated_at FROM session_state WHERE session_id = ?")
      .get<{ current_task: string | null; suggested_next: string | null; updated_at: number }>(sessionId)
    const lastError = db
      .prepare("SELECT error, error_class, updated_at FROM chunks WHERE session_id = ? AND error IS NOT NULL AND state NOT IN ('succeeded','cancelled') ORDER BY updated_at DESC LIMIT 1")
      .get<{ error: string; error_class: string; updated_at: number }>(sessionId)
    const session = getSession(db, sessionId)
    const snapshot = latestContextSnapshot(db, sessionId)
    const capturedTokens = db
      .prepare("SELECT COALESCE(SUM(token_est),0) AS t FROM source_messages WHERE session_id = ? AND status = 'present'")
      .get<{ t: number }>(sessionId)!.t
    return {
      sessionId,
      known: !!session,
      projectId: session?.project_id ?? null,
      title: session?.title ?? null,
      capturedTokens,
      unobservedTokens: backlog.totalTokens,
      unchunkedTokens: u.tokens,
      oldestUnobservedAt: u.oldest,
      bufferTokens: this.config.observe.bufferTokens,
      activationTokens: this.config.observe.activationTokens,
      lastSeq: ingest?.last_seq ?? 0,
      chunkedSeq: ingest?.chunked_seq ?? 0,
      coveredSeq: contiguousCoverage(db, sessionId),
      chunks,
      observations: obs.n,
      observationTokens: obs.t,
      injectedTokens: snapshot?.token_est ?? 0,
      injectedAt: snapshot?.created_at ?? null,
      currentTask: state?.current_task ?? null,
      suggestedNext: state?.suggested_next ?? null,
      lastError: lastError ?? null,
      paused: !!session?.paused,
      excluded: !!session?.excluded,
      forgotten: this.sessionForgotten(sessionId),
      internal: !!session?.internal,
      reverted: !!session?.revert_message_id,
      forkedFrom: session?.fork_source ?? null,
      observing: session ? this.draining.has(session.project_id) : false,
    }
  }

  globalStatus() {
    const db = this.db
    const now = Date.now()
    const count = (sql: string) => db.prepare(sql).get<{ n: number }>()!.n
    const lastAt = (status: "failed" | "succeeded") => lastOperationAt(db, status)
    const reflectLeased = !!db
      .prepare("SELECT 1 FROM jobs WHERE kind = 'reflect' AND state = 'running' AND lease_expires_at > ? LIMIT 1")
      .get(now)
    return {
      byScope: db
        .prepare("SELECT scope_kind, status, COUNT(*) AS n FROM observations WHERE visibility = 'visible' GROUP BY scope_kind, status")
        .all<{ scope_kind: string; status: string; n: number }>(),
      reviewOpen: count("SELECT COUNT(*) AS n FROM review_items WHERE state = 'open'"),
      quarantined: count("SELECT COUNT(*) AS n FROM chunks WHERE state = 'quarantined'"),
      queued: count("SELECT COUNT(*) AS n FROM chunks WHERE state IN ('pending','retryable','running')"),
      vaultPending: count("SELECT COUNT(*) AS n FROM vault_outbox WHERE state = 'pending'"),
      topicConflicts: count("SELECT COUNT(*) AS n FROM topics WHERE state = 'conflict'"),
      usage: usageToday(db),
      cap: { usd: this.config.cost.dailyCapUsd, tokens: this.config.cost.dailyTokenCap },
      recentFailures: db
        .prepare(
          "SELECT kind, error, error_class, started_at, finished_at, COALESCE(finished_at, started_at) AS at FROM operations WHERE status = 'failed' ORDER BY started_at DESC LIMIT 5",
        )
        .all<{ kind: string; error: string; error_class: string; started_at: number; finished_at: number | null; at: number }>(),
      lastFailureAt: lastAt("failed"),
      lastSuccessAt: lastAt("succeeded"),
      instances: db.prepare("SELECT id, pid, directory, project_id, heartbeat_at FROM instances ORDER BY heartbeat_at DESC").all<any>(),
      paused: this.paused,
      pausedReason: this.pausedReason(now),
      observing: this.busy,
      reflecting: this.reflecting.size > 0 || reflectLeased,
      fts5: db.hasFts5,
      driver: db.driver,
      embeddings: this.embedder?.model ?? null,
      dataDir: this.config.dataDir,
      vaultDir: this.config.vaultDir,
    }
  }

  sessions(filter: { projectId?: string; limit?: number } = {}) {
    const where = filter.projectId ? "WHERE s.project_id = ? AND s.internal = 0" : "WHERE s.internal = 0"
    return this.db
      .prepare(
        `SELECT s.id, s.project_id, s.parent_id, s.title, s.excluded, s.paused, s.deleted_at, s.revert_message_id, s.fork_source, s.last_activity_at,
           p.name AS project_name, p.workspace, p.directory,
           (SELECT COUNT(*) FROM observations o WHERE o.session_id = s.id AND o.status IN ('active','pending_review')) AS observations,
           (SELECT COALESCE(SUM(token_est),0) FROM source_messages m WHERE m.session_id = s.id AND m.status = 'present') AS tokens
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id ${where}
         ORDER BY COALESCE(s.last_activity_at, s.updated_at) DESC LIMIT ?`,
      )
      .all<any>(...(filter.projectId ? [filter.projectId] : []), filter.limit ?? 100)
  }

  projects() {
    return this.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.internal = 0) AS sessions,
           (SELECT COUNT(*) FROM observations o WHERE o.project_id = p.id AND o.status = 'active') AS observations
         FROM projects p ORDER BY p.updated_at DESC`,
      )
      .all<any>()
  }

  /** Session timeline: observations in event order plus chunk states over the captured range. */
  timeline(sessionId: string) {
    const observations = this.db
      .prepare(
        `SELECT o.* FROM observations o WHERE o.status NOT IN ('forgotten') AND (o.session_id = ?
           OR EXISTS (SELECT 1 FROM observation_sources s WHERE s.observation_id = o.id AND s.session_id = ?))
         ORDER BY COALESCE(o.event_at, o.observed_at)`,
      )
      .all<ObservationRow>(sessionId, sessionId)
    const chunks = this.db
      .prepare("SELECT id, start_seq, end_seq, state, attempts, error, error_class, reason, token_est, updated_at FROM chunks WHERE session_id = ? ORDER BY start_seq, created_at")
      .all<any>(sessionId)
    const messages = this.db
      .prepare("SELECT id, seq, role, created_at, token_est, status FROM source_messages WHERE session_id = ? ORDER BY seq")
      .all<any>(sessionId)
    return { observations, chunks, messages }
  }

  operations(limit = 50) {
    return recentOperations(this.db, limit)
  }

  jobs() {
    return listJobs(this.db)
  }

  /**
   * Review queue. With a ctx, only items readable from it: the linked observation must pass
   * canRead (so pending rows only show in their own session); vault conflicts only for the
   * ctx's workspace/project topics. Accepts (state, { ctx }) or ({ state, ctx }).
   */
  reviewItems(state: string | { state?: string; ctx?: AccessContext } = "open", opts: { ctx?: AccessContext } = {}) {
    const o = typeof state === "string" ? { state, ctx: opts.ctx } : { state: state.state ?? "open", ctx: state.ctx ?? opts.ctx }
    return listReviewItems(this.db, o.state, 200, o.ctx)
  }

  topics(scopeKeys?: string[]) {
    return listTopics(this.db, scopeKeys)
  }

  topic(id: string) {
    const t = this.db.prepare("SELECT * FROM topics WHERE id = ?").get<any>(id)
    return t ? { ...t, generations: topicGenerations(this.db, id) } : undefined
  }

  learning(workspace: string) {
    return { concepts: listConcepts(this.db, workspace), due: dueReviews(this.db, workspace), calendar: reviewCalendar(this.db, workspace) }
  }

  research(workspace: string) {
    return { claims: listClaims(this.db, workspace), conflicts: conflictReport(this.db, workspace), sources: listSources(this.db, workspace) }
  }

  artifacts(filter: { workspace?: string; projectId?: string; limit?: number }) {
    return listArtifacts(this.db, filter)
  }

  artifactContent(id: string) {
    return this.db.prepare("SELECT id, kind, title, path, content FROM artifacts WHERE id = ?").get<any>(id)
  }

  workspaces(): string[] {
    return this.db
      .prepare("SELECT DISTINCT workspace FROM projects ORDER BY workspace")
      .all<{ workspace: string }>()
      .map((r) => r.workspace)
  }

  // ---------- writes ----------

  /**
   * Direct write. Only the dashboard (actor "user") writes shared scopes directly.
   * Agent writes never count as user attribution: instruction-like agent content is
   * refused outright; agent writes go to review (stored at session scope, or project
   * without a session, with target_scope recorded) when they target workspace/user scope
   * or are a user-sourced, high-impact or mastery kind; otherwise they are active at
   * session or project scope only. Domain hooks run only for rows active at
   * workspace/user scope. Writes into a forgotten (409), excluded or deleted session
   * are refused. `payload` is validated for the kind and sets the subject key.
   */
  remember(ctx: AccessContext, input: RememberInput, now = Date.now()) {
    const content = redact(input.content.trim()).text.slice(0, 1500)
    if (!content) return { ok: false as const, error: "empty content", status: 400 as const }
    const agent = input.actor !== "user"
    if (agent && INSTRUCTION_PATTERN.test(content))
      return { ok: false as const, error: AGENT_INSTRUCTION_REFUSED, status: 400 as const }
    const kind = (ALL_KINDS as readonly string[]).includes(input.kind ?? "") && input.kind !== "condensed" ? input.kind! : "fact"
    const parsed = rememberPayload(kind, input.payload)
    if (!parsed.ok) return { ...parsed, ok: false as const }
    const payload = parsed.payload
    const scope: ScopeKind = input.scope ?? (ctx.sessionId ? "session" : "project")
    const target = { kind: scope, projectId: ctx.projectId, workspace: ctx.workspace, sessionId: ctx.sessionId }
    const shared = scope === "workspace" || scope === "user"
    if (!shared && !canWrite(ctx, target)) return { ok: false as const, error: `cannot write ${scope} memory from here`, status: 403 as const }
    const writeSession = input.sessionId && ctx.sessionId && input.sessionId === ctx.sessionId ? ctx.sessionId : (ctx.sessionId ?? null)
    const blocked = this.sessionWriteBlock(writeSession) ?? this.sessionWriteBlock(input.sessionId)
    if (blocked) return { ...blocked, ok: false as const }

    let status: "active" | "pending_review" = "active"
    let scopeKind: ScopeKind = scope
    let reviewReason: string | null = null
    let targetScope: ScopeKind | null = null
    let evidenceType: string = input.actor === "user" ? "explicit" : "observed"
    let confidence = input.actor === "user" ? 1 : 0.7

    if (agent) {
      const review = shared ? `agent proposal for ${scope} scope requires human review` : agentReviewReason({ kind, content, payload })
      const place: Placement = review
        ? { scopeKind: writeSession ? "session" : "project", status: "pending_review", targetScope: scope, reviewReason: review }
        : placeObservation({
            kind,
            evidenceType: "observed",
            scopeHint: scope,
            hasUserSource: false,
            payload,
            conflict: !!findConflict(this.db, subjectKey(kind, payload, content), contentHash(content), ctx.workspace, ctx.projectId),
            hasSession: !!writeSession,
          })
      if (place.status === "active" && place.scopeKind !== "session" && place.scopeKind !== "project")
        return { ok: false as const, error: `agent memory cannot be active at ${place.scopeKind} scope`, status: 403 as const }
      status = place.status
      scopeKind = place.scopeKind
      reviewReason = place.reviewReason
      targetScope = place.targetScope
      evidenceType = "observed"
      confidence = 0.7
    }

    const projectId = scope === "user" && status === "active" ? null : ctx.projectId
    // Checked where the row lands (a pending row: its target scope), so a scoped forget elsewhere neither blocks nor shows.
    const landing = { scope_kind: status === "pending_review" ? (targetScope ?? scopeKind) : scopeKind, project_id: projectId, workspace: ctx.workspace }
    if (isSuppressed(this.db, content, landing)) return { ok: false as const, error: FORGOTTEN_CONTENT, status: 409 as const }
    const last = writeSession
      ? this.db
          .prepare("SELECT id, seq FROM source_messages WHERE session_id = ? AND status = 'present' ORDER BY seq DESC LIMIT 1")
          .get<{ id: string; seq: number }>(writeSession)
      : undefined
    const id = randomId("obs")
    const r = this.db.tx(() => {
      const out = insertObservation(this.db, {
        id,
        scopeKind: status === "pending_review" ? (writeSession ? "session" : "project") : scopeKind,
        sessionId: writeSession,
        projectId,
        workspace: ctx.workspace,
        chunkId: null,
        kind,
        content,
        eventAt: now,
        observedAt: now,
        confidence,
        evidenceType,
        priority: "medium",
        status,
        reviewReason,
        targetScope,
        payload,
        actor: input.actor,
        sources:
          last && writeSession
            ? [{ sessionId: writeSession, startMessageId: last.id, endMessageId: last.id, startSeq: last.seq, endSeq: last.seq, transformVersion: 1 }]
            : [],
      })
      if (status === "active") applyObservationDomainHooks(this.db, out.id, now)
      return out
    })
    if (r.outcome === "suppressed") return { ok: false as const, error: FORGOTTEN_CONTENT, status: 409 as const }
    return { ok: true as const, id: r.id, outcome: r.outcome, status, scope }
  }

  supersede(ctx: AccessContext | undefined, id: string, content: string, reason: string, actor: "user" | "agent") {
    const row = getObservation(this.db, id)
    if (!row || (ctx && !canRead(ctx, row))) return { ok: false as const, error: "observation not found", status: 404 as const }
    if (ctx && actor === "agent" && (row.scope_kind === "workspace" || row.scope_kind === "user"))
      return { ok: false as const, error: "shared memories can only be replaced from the Memory dashboard", status: 403 as const }
    if (actor === "agent" && row.status === "pending_review")
      return { ok: false as const, error: "pending review items cannot be superseded by the agent", status: 409 as const }
    const text = redact(content).text
    if (actor === "agent" && INSTRUCTION_PATTERN.test(text)) return { ok: false as const, error: AGENT_INSTRUCTION_REFUSED, status: 400 as const }
    if (isSuppressed(this.db, text, suppressionTargetForRow(row))) return { ok: false as const, error: FORGOTTEN_CONTENT, status: 409 as const }
    const blocked =
      this.sessionWriteBlock(ctx?.sessionId) ??
      (row.session_id && this.sessionForgotten(row.session_id) ? this.sessionWriteBlock(row.session_id) : undefined)
    if (blocked) return { ...blocked, ok: false as const }
    const newId = supersedeObservation(this.db, id, { content: text, reason, actor })
    return newId ? { ok: true as const, id: newId } : { ok: false as const, error: "could not supersede", status: 409 as const }
  }

  /**
   * Forget with every derived copy; also prunes vectors and scrubs backups. A ctx admits
   * only ids the caller may forget. scope 'ctx' (the default with a ctx: an agent's forget)
   * never touches rows outside the caller's boundary and scopes the suppressions to it;
   * scope 'global' (the user forgetting from a session view) forgets everywhere. Backups are
   * scrubbed in the background by default; awaitScrub waits (bounded) and reports the counts.
   */
  async forget(
    ids: string[],
    opts: { actor: string; reason: string; purgeSources?: SourcePurge; ctx?: AccessContext; scope?: "global" | "ctx"; awaitScrub?: boolean },
  ): Promise<ForgetResult> {
    const skipped: string[] = []
    let toForget = ids
    if (opts.ctx) {
      toForget = []
      for (const id of ids) {
        const row = getObservation(this.db, id)
        if (row && inForgetScope(opts.ctx, row)) toForget.push(id)
        else skipped.push(id)
      }
    }
    const ctx = opts.scope === "global" ? undefined : opts.ctx
    const result = this.forgetTx(() => forgetObservations(this.db, toForget, { actor: opts.actor, reason: opts.reason, purgeSources: opts.purgeSources, ctx }))
    const done = await this.afterForget(result, opts.awaitScrub)
    return skipped.length ? { ...done, skipped } : done
  }

  forgetCandidates(text: string, ctx?: AccessContext) {
    const rows = findForgetCandidates(this.db, text, 20, ctx)
    if (!ctx) return rows
    return rows.filter((r) => {
      const row = getObservation(this.db, r.id)
      return !!row && inForgetScope(ctx, row)
    })
  }

  async forgetSession(sessionId: string, actor: string, opts?: { awaitScrub?: boolean }) {
    return this.afterForget(
      this.forgetTx(() => forgetSession(this.db, sessionId, actor)),
      opts?.awaitScrub,
    )
  }

  private scrubChain: Promise<unknown> = Promise.resolve()
  private scrubQueued: { files: Set<string> | null; promise: Promise<ScrubResult> } | undefined
  private readonly scrubWaitMs = 60_000
  private readonly closeScrubWaitMs = 5_000
  private readonly watermarks: WatermarkCache = new Map()

  /** The forget commits together with its durable follow-ups: backup scrub and WAL truncation markers. */
  private forgetTx(run: () => ForgetResult): ForgetResult {
    const backups = listBackups(this.config.dataDir).length > 0
    return this.db.tx(() => {
      const result = run()
      if (backups) markScrubPending(this.db, null)
      markWalTruncate(this.db)
      bumpMemoryGeneration(this.db)
      return result
    })
  }

  private async afterForget(result: ForgetResult, awaitScrub?: boolean): Promise<ForgetResult> {
    this.pending.clear()
    try {
      pruneOrphanEmbeddings(this.db)
    } catch (e) {
      this.log("warn", `vector prune after forget failed: ${String(e)}`)
    }
    try {
      materializeOutbox(this.db, this.config.vaultDir, this.owner, Date.now(), { log: (level, msg, extra) => this.log(level, msg, extra) })
    } catch (e) {
      this.log("warn", `vault rewrite after forget failed: ${String(e)}`)
    }
    this.retryWalTruncate()
    if (!listBackups(this.config.dataDir).length) return { ...result, scrubPending: false }
    const scrub = this.queueBackupScrub(null)
    const onError = (e: unknown) => this.log("warn", `backup scrub failed: ${String(e)}`)
    if (!awaitScrub) {
      scrub.catch(onError)
      return { ...result, scrubPending: true }
    }
    try {
      const r = await withTimeout(scrub, this.scrubWaitMs)
      if (r === TIMEOUT) {
        scrub.catch(onError)
        return { ...result, scrubPending: true }
      }
      return { ...result, backupsScrubbed: r.scrubbed, backupsFailed: r.failed.length, scrubPending: r.failed.length > 0 || !!r.aborted }
    } catch (e) {
      onError(e)
      return { ...result, scrubPending: true }
    }
  }

  /** One backup scrub at a time; requests made while one is queued join it (files null = all backups). */
  private queueBackupScrub(files: string[] | null): Promise<ScrubResult> {
    const queued = this.scrubQueued
    if (queued) {
      if (!files) queued.files = null
      else if (queued.files) for (const f of files) queued.files.add(f)
      return queued.promise
    }
    const entry: { files: Set<string> | null; promise: Promise<ScrubResult> } = { files: files ? new Set(files) : null, promise: undefined as never }
    entry.promise = this.scrubChain.then(async () => {
      if (this.scrubQueued === entry) this.scrubQueued = undefined
      if (this.closed) return { scrubbed: 0, failed: [], skipped: 0, aborted: true }
      this.retryWalTruncate()
      try {
        return await scrubBackups(this.db, this.config.dataDir, {
          files: entry.files ? [...entry.files] : undefined,
          signal: this.abort.signal,
          log: (level, msg) => this.log(level, msg),
        })
      } finally {
        this.watermarks.clear()
      }
    })
    this.scrubQueued = entry
    this.scrubChain = entry.promise.catch(() => undefined)
    return entry.promise
  }

  /**
   * Maintenance retry (open and tick): empty the WAL if a forget or restore left that pending,
   * resume a backup scrub left pending (failed file, crash, shutdown) once its backoff is due,
   * and scrub backups whose suppression watermark is behind the live one (made by another
   * handle while a forget committed, or before watermarks existed), a few per run.
   */
  private retryBackupScrub(now = Date.now()) {
    if (this.closed) return
    this.retryWalTruncate()
    if (this.scrubQueued) return
    let files: string[] | null | undefined
    try {
      const due = dueScrub(this.db, now)
      files = due ? due.files : this.staleBackupFiles(now)
    } catch {
      return
    }
    if (files !== undefined) void this.queueBackupScrub(files).catch((e) => this.log("warn", `backup scrub retry failed: ${String(e)}`))
  }

  private staleBackupFiles(now: number): string[] | undefined {
    const backedOff = backedOffBackups(this.db, now)
    if (backedOff === null) return undefined
    const stale = staleBackups(this.db, this.config.dataDir, this.watermarks).filter((f) => !backedOff.has(f))
    return stale.length ? stale.slice(0, 4) : undefined
  }

  /** Checkpoint(TRUNCATE) with a short busy wait; the durable flag keeps it retried while other connections hold the WAL. */
  private retryWalTruncate() {
    try {
      if (walTruncatePending(this.db)) truncateWal(this.db, 200)
    } catch (e) {
      this.log("warn", `WAL truncate failed: ${String(e)}`)
    }
  }

  /** Approval and its domain hooks commit together. Throws MemoryError(forgotten, 409) for content forgotten at the target scope. */
  approve(id: string, edit?: { content?: string }) {
    return this.db.tx(() => {
      const ok = approveObservation(this.db, id, "user", edit)
      if (!ok) return false
      const row = getObservation(this.db, id)
      if (row && isDomainScope(row.scope_kind)) applyObservationDomainHooks(this.db, id)
      else scrubObservationDomain(this.db, id)
      return true
    })
  }

  reject(id: string) {
    return this.db.tx(() => {
      const ok = rejectObservation(this.db, id, "user")
      if (ok) scrubObservationDomain(this.db, id)
      return ok
    })
  }

  edit(id: string, content: string) {
    return editObservation(this.db, id, redact(content).text, "user")
  }

  pin(id: string, pinned: boolean) {
    return setPinned(this.db, id, pinned, "user")
  }

  approvePromotion(reviewId: string) {
    return applyPromotion(this.db, reviewId, "user")
  }

  resolveReview(reviewId: string, decision: "approve" | "reject", edit?: { content?: string }) {
    const item = this.db.prepare("SELECT * FROM review_items WHERE id = ?").get<{ kind: string; ref_id: string; state: string }>(reviewId)
    if (!item || item.state !== "open") return false
    if (item.kind === "promotion") {
      if (decision === "approve") return this.approvePromotion(reviewId)
      this.db.prepare("UPDATE review_items SET state = 'rejected', resolved_at = ?, resolved_by = 'user' WHERE id = ?").run(Date.now(), reviewId)
      return true
    }
    if (item.kind === "vault-conflict") return resolveVaultConflict(this.db, item.ref_id, this.config.vaultDir, decision === "approve" ? "keep-file" : "overwrite")
    if (item.kind === "source-reverted") {
      this.db.tx(() => {
        if (decision === "reject") {
          this.db.prepare("UPDATE observations SET visibility = 'reverted', updated_at = ? WHERE id = ?").run(Date.now(), item.ref_id)
          bumpMemoryGeneration(this.db)
        }
        this.db
          .prepare("UPDATE review_items SET state = ?, resolved_at = ?, resolved_by = 'user' WHERE id = ?")
          .run(decision === "approve" ? "approved" : "rejected", Date.now(), reviewId)
      })
      return true
    }
    return decision === "approve" ? this.approve(item.ref_id, edit) : this.reject(item.ref_id)
  }

  retryChunk(id: string) {
    const chunk = this.db.prepare("SELECT session_id, project_id FROM chunks WHERE id = ?").get<{ session_id: string; project_id: string }>(id)
    const ok = retryChunk(this.db, id)
    if (ok && chunk) {
      activateBufferChunks(this.db, chunk.session_id, "manual")
      this.kick(chunk.project_id)
    }
    return ok
  }

  retryQuarantined(sessionId?: string) {
    const n = retryAllQuarantined(this.db, sessionId)
    if (n) {
      const sessions = sessionId
        ? [sessionId]
        : this.db
            .prepare("SELECT DISTINCT session_id FROM chunks WHERE reason = 'buffer' AND state = 'pending'")
            .all<{ session_id: string }>()
            .map((r) => r.session_id)
      for (const id of sessions) activateBufferChunks(this.db, id, "manual")
      this.kick()
    }
    return n
  }

  approveTopic(id: string) {
    return approveTopic(this.db, id)
  }

  rollbackTopic(id: string, generation: number) {
    return rollbackTopic(this.db, id, generation, "user")
  }

  backupNow() {
    return backupNow(this.db, this.config.dataDir, this.config.backup.keep)
  }

  backups() {
    return listBackups(this.config.dataDir)
  }

  /** Only a listed backup by file name; throws MemoryError 400 (unknown/invalid name) or 409 (refused backup). */
  restore(file: string) {
    const known = typeof file === "string" && file ? listBackups(this.config.dataDir).find((b) => b.file === file) : undefined
    if (!known) throw new MemoryError("unknown backup", "invalid", 400)
    const r = restoreBackup(this.db, known.path)
    this.pending.clear()
    this.retryWalTruncate()
    return r
  }

  exportJson(workspace?: string) {
    return exportJson(this.db, { workspace })
  }

  // ---------- lifecycle ----------

  onRevert(sessionId: string, messageId: string) {
    const s = getSession(this.db, sessionId)
    if (!s || s.revert_message_id === messageId) return undefined
    this.pending.delete(sessionId)
    return applyRevert(this.db, sessionId, messageId)
  }

  onUnrevert(sessionId: string, presentIds: Set<string>) {
    const s = getSession(this.db, sessionId)
    if (!s?.revert_message_id) return undefined
    const r = clearRevert(this.db, sessionId, presentIds)
    this.scheduleCuts(sessionId)
    return r
  }

  onFork(sessionId: string, lineage: ForkLineage, now = Date.now()) {
    return recordForkLineage(this.db, sessionId, lineage, now)
  }

  onSessionDeleted(sessionId: string) {
    this.pending.delete(sessionId)
    cancelOpenChunks(this.db, sessionId)
    markSessionDeleted(this.db, sessionId)
  }

  private skipCapture(adapter: InstanceAdapter, sessionId: string): boolean {
    if (this.isInternal(sessionId) || adapter.project.excluded) return true
    const s = getSession(this.db, sessionId)
    return !s || !!s.internal || !!s.excluded || !!s.paused || s.deleted_at != null
  }

  captureToolArtifacts(adapter: InstanceAdapter, sessionId: string, tool: string, args: unknown) {
    if (this.skipCapture(adapter, sessionId)) return []
    try {
      return captureToolArtifacts(this.db, {
        tool,
        args,
        directory: adapter.directory,
        workspace: adapter.project.workspace,
        projectId: adapter.project.id,
        sessionId,
      })
    } catch (e) {
      this.log("warn", `artifact capture failed: ${String(e)}`)
      return []
    }
  }

  captureInlineArtifacts(adapter: InstanceAdapter, sessionId: string, messageId: string, text: string) {
    if (this.skipCapture(adapter, sessionId)) return []
    if (!/```(svg|mermaid|xml)|<svg[\s>]/i.test(text)) return []
    return captureInlineArtifacts(this.db, { text, workspace: adapter.project.workspace, projectId: adapter.project.id, sessionId, messageId })
  }

  updateConfig(config: MemoryConfig, opts?: { trusted?: boolean }) {
    this.config = opts?.trusted ? config : sanitizeConfigPatch(this.config, config)
    this.embedder = createEmbedder(this.config.embeddings)
    bumpMemoryGeneration(this.db)
    this.kick()
  }

  estimate(text: string) {
    return estimateTokens(text)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.abort.abort()
    await Promise.allSettled([...this.draining.values(), ...this.reflecting.values(), ...this.commanding.values()])
    await withTimeout(this.scrubChain, this.closeScrubWaitMs).catch(() => undefined)
    try {
      releaseOwner(this.db, this.owner)
      for (const id of this.adapters.keys()) this.db.prepare("DELETE FROM instances WHERE id = ?").run(id)
    } catch {}
    this.adapters.clear()
    this.db.close()
  }
}
