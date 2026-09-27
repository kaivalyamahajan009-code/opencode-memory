import type { ServedConfig } from "../../core/src/contract"
import { ApiError, requestJson } from "./api-unwrap"
import { forgetCandidatesBody, type ForgetBody } from "./forget-select"
import { unwrapRecall, withVia, type RecallRequest } from "./recall"
import type {
  ArtifactContent,
  ArtifactRow,
  BackupRow,
  ContextPayload,
  ForgetCandidate,
  ForgetResult,
  JobRow,
  LearningPayload,
  MemoryConfigView,
  MutationDone,
  ObservationDetail,
  ObservationRow,
  OperationRow,
  ProjectRow,
  RecallResult,
  RedactTestResult,
  ResearchPayload,
  ReviewItem,
  SearchHit,
  SessionListItem,
  StatusPayload,
  TimelinePayload,
  TopicDetail,
  TopicRow,
} from "./types"

const TOKEN_META = "om-token"
const CONFIG_META = "om-config"

export { ApiError }

function metaContent(name: string): string {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? ""
}

export function readToken(): string {
  const fromMeta = metaContent(TOKEN_META)
  if (fromMeta) return fromMeta
  if (import.meta.env.DEV) {
    const env = import.meta.env.VITE_OM_TOKEN
    return typeof env === "string" ? env : ""
  }
  return ""
}

export function readServedConfig(): ServedConfig | undefined {
  const raw = metaContent(CONFIG_META)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as ServedConfig
  } catch {
    return undefined
  }
}

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>((input, i) => fetch(input, i), path, readToken(), init)
}

export function get<T>(path: string): Promise<T> {
  return api<T>(path)
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) })
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    u.set(k, String(v))
  }
  const s = u.toString()
  return s ? `?${s}` : ""
}

export function fetchStatus(session?: string) {
  return get<StatusPayload>(`/api/status${qs({ session })}`)
}

export function fetchConfig() {
  return get<MemoryConfigView>("/api/config")
}

export function patchConfig(patch: unknown) {
  return post<unknown>("/api/config", { patch })
}

export function fetchReview(state = "open", session?: string) {
  return get<ReviewItem[]>(`/api/review${qs({ state, session })}`)
}

export function decideReview(id: string, decision: "approve" | "reject", content?: string) {
  return post<MutationDone>(`/api/review/${encodeURIComponent(id)}`, { decision, content })
}

export function fetchContext(session?: string) {
  return get<ContextPayload>(`/api/context${qs({ session })}`)
}

export function fetchTimeline(session?: string) {
  return get<TimelinePayload>(`/api/timeline${qs({ session })}`)
}

export function fetchObservation(id: string) {
  return get<ObservationDetail>(`/api/observations/${encodeURIComponent(id)}`)
}

export function fetchObservations(filter: Record<string, string | number | undefined> = {}) {
  return get<ObservationRow[]>(`/api/observations${qs(filter)}`)
}

export function pinObservation(id: string, pinned: boolean) {
  return post<MutationDone>(`/api/observations/${encodeURIComponent(id)}/pin`, { pinned })
}

export function editObservation(id: string, content: string) {
  return post<MutationDone>(`/api/observations/${encodeURIComponent(id)}/edit`, { content })
}

export function supersedeObservation(id: string, content: string, reason: string) {
  return post<{ id?: string } | MutationDone>(`/api/observations/${encodeURIComponent(id)}/supersede`, { content, reason })
}

export function fetchSearch(q: string, extra: Record<string, string | number | undefined> = {}) {
  return get<SearchHit[] | ObservationRow[]>(`/api/search${qs({ q, ...extra })}`)
}

export function unwrapHits(data: SearchHit[] | ObservationRow[] | undefined): SearchHit[] {
  if (!data?.length) return []
  return data.map((h) => {
    if (h && typeof h === "object" && "row" in h) return h as SearchHit
    return { row: h as ObservationRow, score: 0 }
  })
}

export async function fetchRecall(params: RecallRequest): Promise<RecallResult> {
  try {
    const data = await get<unknown>(`/api/recall${qs(params)}`)
    return withVia(unwrapRecall(data), params)
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message }
    throw e
  }
}

export function fetchLearning(workspace?: string) {
  return get<LearningPayload>(`/api/learning${qs({ workspace })}`)
}

export function fetchResearch(workspace?: string) {
  return get<ResearchPayload>(`/api/research${qs({ workspace })}`)
}

export function fetchProjects() {
  return get<ProjectRow[]>("/api/projects")
}

export function fetchWorkspaces() {
  return get<string[]>("/api/workspaces")
}

export function fetchSessions(project?: string, limit = 100) {
  return get<SessionListItem[]>(`/api/sessions${qs({ project, limit })}`)
}

export function fetchTopics(scope?: string) {
  return get<TopicRow[]>(`/api/topics${qs({ scope })}`)
}

export function fetchTopic(id: string) {
  return get<TopicDetail>(`/api/topics/${encodeURIComponent(id)}`)
}

export function approveTopic(id: string) {
  return post<MutationDone>(`/api/topics/${encodeURIComponent(id)}/approve`, {})
}

export function rollbackTopic(id: string, generation: number) {
  return post<MutationDone>(`/api/topics/${encodeURIComponent(id)}/rollback`, { generation })
}

export function fetchArtifacts(workspace?: string, project?: string) {
  return get<ArtifactRow[]>(`/api/artifacts${qs({ workspace, project })}`)
}

export function fetchArtifact(id: string) {
  return get<ArtifactContent>(`/api/artifacts/${encodeURIComponent(id)}`)
}

export function fetchOperations(limit = 50) {
  return get<OperationRow[]>(`/api/operations${qs({ limit })}`)
}

export function fetchJobs() {
  return get<JobRow[]>("/api/jobs")
}

export function fetchBackups() {
  return get<BackupRow[]>("/api/backups")
}

export function createBackup() {
  return post<{ file: string }>("/api/backups", {})
}

export function restoreBackup(file: string) {
  return post<unknown>("/api/backups/restore", { file, confirm: true })
}

export function fetchExport(workspace?: string) {
  return get<unknown>(`/api/export${qs({ workspace })}`)
}

export function redactTest(text: string) {
  return post<RedactTestResult>("/api/redact-test", { text })
}

export function flushSession(session: string) {
  return post<unknown>("/api/flush", { session })
}

export function fetchCommand(id: number) {
  return get<unknown>(`/api/commands/${encodeURIComponent(String(id))}`)
}

export function setPaused(paused: boolean, untilMs?: number) {
  return post<MutationDone>("/api/pause", { paused, untilMs })
}

export function setSessionFlags(id: string, flags: { paused?: boolean; excluded?: boolean }) {
  return post<MutationDone>(`/api/sessions/${encodeURIComponent(id)}/flags`, flags)
}

export function forgetObservations(body: ForgetBody) {
  return post<ForgetResult>("/api/forget", body)
}

export function forgetCandidates(text: string) {
  return post<ForgetCandidate[]>("/api/forget/candidates", forgetCandidatesBody(text))
}

export function forgetSession(session: string) {
  return post<ForgetResult>("/api/forget/session", { session, confirm: true })
}

export function retryChunk(id: string) {
  return post<MutationDone>(`/api/chunks/${encodeURIComponent(id)}/retry`, {})
}

export function retryQuarantined(session?: string) {
  return post<{ n: number }>("/api/chunks/retry-quarantined", { session })
}

/** 400: invalid content or payload; 409: the session was forgotten, excluded or deleted. */
export function remember(body: { content: string; kind?: string; scope: string; session?: string; project?: string; payload?: Record<string, unknown> }) {
  return post<{ id: string; status: string; scope: string }>("/api/remember", body)
}
