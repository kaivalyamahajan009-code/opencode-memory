import {
  loadProjectConfig,
  sha256,
  type ForkLineageMetadata,
  type InstanceAdapter,
  type ModelRunner,
  type OcMessage,
  type OcPart,
  type ProjectInfo,
  type SessionMeta,
} from "@opencode-memory/core"
import { OBSERVER_TITLE, REFLECTOR_TITLE } from "./runners/opencode-session"

export type SdkMessage = { info: Record<string, any>; parts?: Record<string, any>[] }
export type SdkSession = Record<string, any>
export type SdkProject = { id: string; worktree?: string; [k: string]: unknown }

export type OcClient = {
  session: {
    create: (opts: any) => Promise<{ data?: { id: string } & Record<string, any>; error?: any }>
    prompt: (opts: any) => Promise<{ data?: { info: any; parts?: any[] }; error?: any }>
    abort: (opts: any) => Promise<any>
    delete: (opts: any) => Promise<any>
    messages: (opts: any) => Promise<{ data?: SdkMessage[]; error?: any }>
    get?: (opts: any) => Promise<{ data?: SdkSession; error?: any }>
    list?: (opts?: any) => Promise<{ data?: SdkSession[]; error?: any }>
  }
  app?: { log?: (opts: any) => Promise<any> }
}

export function resolveProjectId(project: { id: string }, directory: string): string {
  if (project.id === "global") return `dir:${sha256(directory).slice(0, 16)}`
  return project.id
}

export function projectInfo(directory: string, project: { id: string }, fallbackName?: string): ProjectInfo & { excluded?: boolean } {
  const pc = loadProjectConfig(directory, fallbackName)
  return {
    id: resolveProjectId(project, directory),
    workspace: pc.workspace,
    domain: pc.domain,
    name: pc.name,
    directory,
    excluded: pc.exclude,
  }
}

export function toOcPart(p: Record<string, any>): OcPart {
  return {
    id: String(p.id ?? ""),
    type: String(p.type ?? "text"),
    text: typeof p.text === "string" ? p.text : undefined,
    synthetic: p.synthetic,
    ignored: p.ignored,
    tool: typeof p.tool === "string" ? p.tool : undefined,
    callID: p.callID,
    state: p.state,
    mime: p.mime,
    filename: p.filename,
    url: p.url,
    files: p.files,
    name: p.name,
    prompt: p.prompt,
    description: p.description,
    agent: p.agent,
  }
}

export function toOcMessage(row: SdkMessage): OcMessage {
  const info = row.info ?? {}
  return {
    info: {
      id: String(info.id ?? ""),
      sessionID: String(info.sessionID ?? ""),
      role: info.role === "assistant" ? "assistant" : "user",
      time: {
        created: Number(info.time?.created ?? 0),
        completed: info.time?.completed,
      },
      agent: info.agent ?? info.mode,
      mode: info.mode,
      modelID: info.modelID,
      providerID: info.providerID,
      model: info.model,
      error: info.error,
      cost: info.cost,
      summary: info.summary,
    },
    parts: (row.parts ?? []).map(toOcPart),
  }
}

export function parseFork(raw: unknown): ForkLineageMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const f = raw as Record<string, unknown>
  if (typeof f.sourceSessionID !== "string" || !f.sourceSessionID) return undefined
  if (!f.messages || typeof f.messages !== "object") return undefined
  return {
    sourceSessionID: f.sourceSessionID,
    boundaryMessageID: typeof f.boundaryMessageID === "string" ? f.boundaryMessageID : undefined,
    messages: f.messages as Record<string, string>,
    parts: f.parts && typeof f.parts === "object" ? (f.parts as Record<string, string>) : undefined,
  }
}

export function toSessionMeta(info: SdkSession): SessionMeta {
  return {
    id: String(info.id ?? ""),
    parentID: info.parentID,
    title: info.title,
    revertMessageID: info.revert?.messageID ?? null,
    fork: parseFork(info.metadata?.fork),
  }
}

export function textFromParts(parts: { type?: string; text?: string }[] | undefined): string {
  if (!parts?.length) return ""
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
}

const RUNNER_TITLES = new Set([OBSERVER_TITLE, REFLECTOR_TITLE])
const RUNNER_AGENTS = new Set(["om-observer", "om-reflector"])
const ORPHAN_AGE_MS = 10 * 60_000
const ORPHAN_LIMIT = 20
const ORPHAN_CHECKS = 40
const WORKER_MESSAGES_MAX = 20

/** A worker session is short and was started by an om-* agent; the listing is newest-first, capped. */
async function startedByWorker(client: OcClient, id: string, directory: string): Promise<boolean> {
  const r = await client.session.messages({ path: { id }, query: { directory, limit: WORKER_MESSAGES_MAX } }).catch(() => undefined)
  const rows = r?.data ?? []
  if (!rows.length || rows.length >= WORKER_MESSAGES_MAX) return false
  const first = rows.reduce((a, b) => (Number(b.info?.time?.created ?? 0) < Number(a.info?.time?.created ?? 0) ? b : a))
  return RUNNER_AGENTS.has(String(first.info?.agent ?? first.info?.mode ?? ""))
}

/**
 * Best-effort: delete stale observer/reflector child sessions left behind by a crash. Only
 * exact runner titles qualify, and only sessions this process created or whose first
 * message came from an om-* agent, so a user's own `[memory] …` session is never touched.
 */
export async function sweepOrphanMemorySessions(
  client: OcClient,
  directory: string,
  log?: (level: "debug" | "info" | "warn" | "error", msg: string) => void,
  inFlight: (id: string) => boolean = () => false,
  createdHere: (id: string) => boolean = () => false,
): Promise<void> {
  if (!client.session.list) return
  try {
    const listed = await client.session.list({ query: { directory } })
    const rows = listed?.data ?? []
    const now = Date.now()
    let n = 0
    let checks = 0
    for (const s of rows) {
      if (n >= ORPHAN_LIMIT || checks >= ORPHAN_CHECKS) break
      const id = typeof s.id === "string" ? s.id : ""
      if (!id || !RUNNER_TITLES.has(String(s.title ?? "")) || inFlight(id)) continue
      const updated = Number(s.time?.updated ?? s.time?.created ?? 0)
      if (!updated || now - updated < ORPHAN_AGE_MS) continue
      if (s.time?.compacting) continue
      if (!createdHere(id)) {
        checks++
        if (!(await startedByWorker(client, id, directory))) continue
      }
      await client.session.delete({ path: { id }, query: { directory } }).catch(() => {})
      n++
    }
    if (n) log?.("info", `swept ${n} orphaned [memory] session(s)`)
  } catch (e) {
    log?.("warn", `orphan sweep failed: ${String(e)}`)
  }
}

export function createAdapter(opts: {
  client: OcClient
  directory: string
  project: { id: string }
  runner: ModelRunner
  reflectRunner?: ModelRunner
  fallbackName?: string
}): InstanceAdapter {
  const directory = opts.directory
  const project = projectInfo(directory, opts.project, opts.fallbackName)
  return {
    id: sha256(directory).slice(0, 16),
    directory,
    project,
    runner: opts.runner,
    reflectRunner: opts.reflectRunner,
    async fetchMessages(sessionId) {
      const r = await opts.client.session.messages({ path: { id: sessionId }, query: { directory } })
      if (r.error) throw r.error
      return (r.data ?? []).map(toOcMessage)
    },
    async fetchSession(sessionId) {
      if (!opts.client.session.get) return undefined
      const r = await opts.client.session.get({ path: { id: sessionId }, query: { directory } })
      if (!r.data) return undefined
      return toSessionMeta(r.data)
    },
  }
}
