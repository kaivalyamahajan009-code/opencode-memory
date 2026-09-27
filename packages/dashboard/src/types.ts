import type { MemoryState } from "../../core/src/contract"

export type ScopeKind = "session" | "project" | "workspace" | "user"

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
  payload: string | Record<string, unknown> | null
  subject_key: string | null
  from_recall: number
  generation: number
  token_est: number
  actor: string
  updated_at: number
}

export type ObservationSource = {
  observation_id?: string
  session_id: string
  start_message_id: string
  end_message_id: string
  start_seq: number
  end_seq: number
  part_ids?: string[] | null
  transform_version?: number
}

export type ObservationEvent = {
  id?: number
  observation_id?: string
  type: string
  actor: string
  at: number
  data?: unknown
}

export type ObservationDetail = ObservationRow & {
  payload: Record<string, unknown>
  sources: ObservationSource[]
  events: ObservationEvent[]
  reviews: ReviewItem[]
}

export type SearchHit = { row: ObservationRow; score: number; text?: number; vector?: number }

export type RecallPart = {
  id: string
  type: string
  tool: string | null
  text: string
  redactions: number
  omitted: number
  forgotten: boolean
  /** The text was cut to fit the recall budget; it ends with a "[… N chars omitted …]" marker. */
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

/** Engine cursor for the rest of a truncated recall; older engines send `{ sessionId, fromSeq }`. */
export type RecallCursor = {
  fromSeq: number
  toSeq?: number
  context?: number
  observationId?: string
  sessionId?: string
}

/** Who reads: /api/recall resolves the access context from `session`, then `project`, else the server's first local project. */
export type RecallVia = { session?: string; project?: string }

export type RecallOk = {
  ok: true
  guarantee: string
  sessionId: string
  fromSeq: number
  toSeq: number
  messages: RecallMessage[]
  cited?: [number, number][]
  truncated?: boolean
  nextCursor?: RecallCursor
  /** Client-side: the access hints of the request that produced this page, reused for "Load more". */
  via?: RecallVia
}

export type RecallResult = RecallOk | { ok: false; error: string }

export type Usage = { costUsd: number; tokens: number; reservedUsd: number; runs: number; failures: number }

export type ChunkStat = { n: number; tokens: number }

export type SessionStatus = {
  sessionId: string
  known: boolean
  projectId: string | null
  title: string | null
  capturedTokens: number
  unobservedTokens: number
  unchunkedTokens: number
  oldestUnobservedAt: number | null
  bufferTokens: number
  activationTokens: number
  lastSeq: number
  chunkedSeq: number
  coveredSeq: number
  chunks: Record<string, ChunkStat>
  observations: number
  observationTokens: number
  injectedTokens: number
  injectedAt: number | null
  currentTask: string | null
  suggestedNext: string | null
  lastError: { error: string; error_class: string; updated_at: number } | null
  paused: boolean
  excluded: boolean
  /** Forgotten sessions stay excluded; un-excluding one is refused with 409. Absent on older servers. */
  forgotten?: boolean
  internal: boolean
  reverted: boolean
  forkedFrom: string | null
  observing: boolean
}

export type GlobalStatus = {
  byScope: { scope_kind: string; status: string; n: number }[]
  reviewOpen: number
  quarantined: number
  queued: number
  vaultPending: number
  topicConflicts: number
  usage: Usage
  cap: { usd: number; tokens: number }
  recentFailures: { kind: string; error: string; error_class: string; started_at: number }[]
  instances: { id: string; pid: number; directory: string; project_id: string; heartbeat_at: number }[]
  paused: boolean
  pausedReason?: string | null
  observing: boolean
  reflecting?: boolean
  lastFailureAt?: number | null
  lastSuccessAt?: number | null
  fts5: boolean
  driver: string
  embeddings: string | null
  dataDir: string
  vaultDir: string
}

export type StatusPayload = { global: GlobalStatus; session?: SessionStatus }

export type ContextSnapshot = {
  id: string
  session_id?: string
  request_key: string
  agent: string | null
  model: string | null
  memory_generation: number
  observation_ids?: string[] | string
  block?: string
  token_est: number
  created_at: number
}

export type ContextPayload = {
  latest?: ContextSnapshot & { block?: string; observation_ids?: string[] }
  snapshots: ContextSnapshot[]
}

export type TimelinePayload = {
  observations: ObservationRow[]
  chunks: {
    id: string
    start_seq: number
    end_seq: number
    state: string
    attempts: number
    error: string | null
    error_class: string | null
    reason: string | null
    token_est: number
    updated_at: number
  }[]
  messages: { id: string; seq: number; role: string; created_at: number; token_est: number; status: string }[]
}

export type ReviewItem = {
  id: string
  /** The linked observation's kind (null for vault conflicts); older servers put the review kind here. */
  kind?: string | null
  /** observation | promotion | source-reverted | vault-conflict */
  review_kind?: string | null
  ref_id: string
  reason: string
  state: string
  data?: unknown
  created_at: number
  resolved_at?: number | null
  resolved_by?: string | null
  content?: string | null
  confidence?: number | null
  evidence_type?: string | null
  scope_kind?: string | null
  target_scope?: string | null
  session_id?: string | null
  project_id?: string | null
  workspace?: string | null
  status?: string | null
  visibility?: string | null
  supersedes_id?: string | null
}

export type SessionListItem = {
  id: string
  project_id: string
  parent_id: string | null
  title: string | null
  excluded: number
  paused: number
  deleted_at: number | null
  revert_message_id: string | null
  fork_source: string | null
  last_activity_at: number | null
  project_name: string | null
  workspace: string
  directory: string | null
  observations: number
  tokens: number
}

export type ProjectRow = {
  id: string
  workspace: string
  domain: string | null
  name: string | null
  directory: string | null
  sessions?: number
  observations?: number
}

export type ConceptState = {
  id: string
  name: string
  slug: string
  level: string
  attempts: number
  independentCorrect: number
  assisted: number
  incorrect: number
  distinctDays: number
  openMisconceptions: number
  lastIndependentAt: number | null
  dueAt: number | null
  approvedMastery: boolean
}

export type DueReview = { id: string; name: string; due_at: number; reps: number; lapses: number }

export type LearningPayload = {
  concepts: ConceptState[]
  due: DueReview[]
  calendar: { date: string; count: number }[]
}

export type ClaimRow = {
  id: string
  statement: string
  status: string
  conditions: string | null
  confidence: number
  updated_at: number
  support: { id: string; stance: string; quotation?: string; content?: string; title?: string; url?: string }[]
  contradict: { id: string; stance: string; quotation?: string; content?: string; title?: string; url?: string }[]
}

export type ResearchPayload = {
  claims: ClaimRow[]
  conflicts: ClaimRow[]
  sources: {
    id: string
    url?: string | null
    doi?: string | null
    title?: string | null
    evidence_count?: number
    created_at?: number
  }[]
}

export type TopicRow = {
  id: string
  scope_key: string
  slug: string
  rel_path: string
  title: string
  summary: string | null
  body: string
  generation: number
  state: string
  approved: number
  updated_at: number
}

export type TopicGeneration = {
  topic_id: string
  generation: number
  title: string
  hash: string
  actor: string
  created_at: number
}

export type TopicDetail = TopicRow & { generations: TopicGeneration[] }

export type ArtifactRow = {
  id: string
  workspace: string
  project_id: string | null
  session_id: string | null
  message_id: string | null
  path: string
  kind: "svg" | "mermaid" | string
  origin: string
  hash: string
  title: string | null
  concepts: string | string[] | null
  created_at: number
  updated_at: number
  has_content?: number | boolean
}

export type ArtifactContent = { id: string; kind: string; title: string | null; path: string; content: string | null }

export type OperationRow = {
  id: string
  kind: string
  session_id: string | null
  project_id: string | null
  ref_id: string | null
  runner: string | null
  model: string | null
  status: string
  reserved_cost: number
  cost: number
  input_tokens: number
  output_tokens: number
  error: string | null
  error_class: string | null
  started_at: number
  finished_at: number | null
}

export type JobRow = {
  key: string
  kind: string
  state: string
  lease_owner: string | null
  lease_expires_at: number | null
  version: number
  attempts: number
  error: string | null
  next_attempt_at: number | null
  updated_at: number
}

export type BackupRow = { file: string; path?: string; size: number; createdAt: number }

export type ForgetCandidate = { id: string; content: string; score: number }

export type ForgetResult = {
  observationIds: string[]
  partsPurged: number
  topicsTouched: string[]
  snapshotsPurged: number
  /** Requested ids outside the caller's forget scope; they were left untouched. */
  skipped?: string[]
  /** Sources of a forgotten condensed summary that are current again. */
  reactivated?: string[]
  /** Backups rewritten without the content (only when the server waited for the scrub). */
  backupsScrubbed?: number
  /** Backups that could not be scrubbed yet; the engine retries them. */
  backupsFailed?: number
  /** Backups still hold the content until the background scrub finishes. */
  scrubPending?: boolean
}

export type RedactTestResult = { text: string; count: number; rules: string[] }

export type MemoryConfigView = {
  port?: number
  allowedOrigins?: string[]
  dataDir?: string
  vaultDir?: string
  observe?: Record<string, number>
  reflect?: Record<string, number>
  inject?: { enabled?: boolean; deadlineMs?: number; budget?: Record<string, number> }
  cost?: Record<string, number>
  runner?: {
    kind?: string
    timeoutMs?: number
    model?: { providerID: string; modelID: string }
    direct?: { baseURL?: string; apiKeyEnv?: string; headers?: Record<string, string> }
  }
  reflectorRunner?: { kind?: string; timeoutMs?: number; model?: { providerID: string; modelID: string } }
  pruning?: { enabled?: boolean; keepRecentTurns?: number }
  backup?: { keep?: number; autoDaily?: boolean }
  embeddings?: { provider?: string; model?: string; baseURL?: string; apiKeyEnv?: string; headers?: Record<string, string> }
}

export type MutationDone = { done: boolean }

export type HostContext = {
  sessionID: string
  directory: string
  theme: "light" | "dark" | undefined
  locale: string
}

export const KINDS = [
  "fact",
  "preference",
  "goal",
  "decision",
  "task-state",
  "event",
  "personal-fact",
  "project-context",
  "tool-outcome",
  "prior-knowledge",
  "quiz-attempt",
  "demonstrated-skill",
  "misconception",
  "hint-required",
  "teaching-intervention",
  "retention-check",
  "learning-preference",
  "next-review",
  "idea",
  "hypothesis",
  "claim",
  "source",
  "quotation",
  "evidence",
  "counter-evidence",
  "experiment",
  "open-question",
  "conclusion",
  "superseded-conclusion",
  "artifact",
  "condensed",
] as const

export const EVIDENCE_TYPES = ["explicit", "observed", "inferred", "source", "quiz", "tool"] as const

export const STATUSES = ["active", "pending_review", "superseded", "reverted", "rejected", "expired", "forgotten"] as const

export type { MemoryState }
