import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { defaultConfig as baseConfig, mergeConfig, type MemoryConfig } from "../src/config"
import { openDatabase, type Database } from "../src/sqlite"
import { migrate } from "../src/schema-sql"
import { upsertProject, upsertSession, ingestMessages, type IngestOptions, type ProjectInfo } from "../src/ingest"
import type { OcMessage, OcPart, StoredMessage, StoredPart } from "../src/normalize"
import { MemoryEngine, type InstanceAdapter, type LogFn, type SessionMeta } from "../src/engine"
import { insertObservation, type NewObservation, type SourceRange } from "../src/observations"
import type { Payload } from "../src/schemas"
import type { ScopeKind } from "../src/scope"
import { randomId } from "../src/util"
import { classifyError, RunnerError, type ModelRunner, type RunRequest, type RunResult } from "../src/runner"

const TEMPS: string[] = []

export const T0 = 1_700_000_000_000

export function tempDir(): string {
  const dir = join(tmpdir(), `om-${randomBytes(6).toString("hex")}`)
  mkdirSync(dir, { recursive: true })
  TEMPS.push(dir)
  return dir
}

export function cleanupDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {}
}

export function cleanupAllTempDirs() {
  for (const d of TEMPS.splice(0)) cleanupDir(d)
}

/** Test config: small chunk/buffer/inject thresholds so fixtures stay tiny. */
export function defaultConfig(tmpDir: string): MemoryConfig {
  return mergeConfig(baseConfig(tmpDir), {
    capture: {
      captureReasoning: false,
      observeSubagents: false,
      snapshotToolOutputMax: 4_000,
      staleIncompleteMs: 60_000,
    },
    observe: {
      bufferTokens: 80,
      activationTokens: 200,
      maxChunkTokens: 50,
      minFlushTokens: 10,
      idleFlushMs: 60_000,
      maxUnobservedAgeMs: 30_000,
      observerToolOutputMax: 400,
      maxAttempts: 3,
      leaseMs: 2_000,
      concurrency: 1,
    },
    reflect: { thresholdTokens: 500, minNewDurable: 3 },
    inject: {
      enabled: true,
      deadlineMs: 5_000,
      budget: { profile: 80, workspace: 80, project: 80, session: 120, task: 40, recall: 80 },
    },
    cost: { dailyCapUsd: 1, dailyTokenCap: 2_000_000, estimatePerRunUsd: 0.01 },
    runner: { kind: "opencode-session", timeoutMs: 15_000 },
    backup: { keep: 3, autoDaily: false },
  })
}

export const CAPTURE: Pick<IngestOptions, "captureReasoning" | "toolOutputMax" | "staleIncompleteMs"> = {
  captureReasoning: false,
  toolOutputMax: 4_000,
  staleIncompleteMs: 60_000,
}

export const CUT = { bufferTokens: 80, maxChunkTokens: 50, minFlushTokens: 10 }

export function textOfTokens(tokens: number, word = "word"): string {
  const unit = `${word} `
  const target = Math.max(0, tokens) * 4
  if (!target) return ""
  return unit.repeat(Math.ceil(target / unit.length)).slice(0, target)
}

export function part(type: OcPart["type"], extra: Partial<OcPart> & { text?: string } = {}): OcPart {
  const { text, ...rest } = extra
  return { id: rest.id ?? randomId("pt"), type, text, ...rest }
}

export function textPart(text: string, id?: string): OcPart {
  return { id: id ?? randomId("pt"), type: "text", text }
}

export function toolPart(tool: string, output: string, extra: { id?: string; status?: string; input?: Record<string, unknown> } = {}): OcPart {
  return {
    id: extra.id ?? randomId("pt"),
    type: "tool",
    tool,
    state: { status: extra.status ?? "completed", output, input: extra.input ?? {} },
  }
}

export function ocMessage(opts: {
  role: "user" | "assistant"
  text?: string
  parts?: OcPart[]
  id?: string
  sessionID?: string
  at?: number
  completed?: number
  incomplete?: boolean
  agent?: string
}): OcMessage {
  const at = opts.at ?? T0
  const completed = opts.incomplete ? undefined : (opts.completed ?? (opts.role === "user" ? at : at + 1))
  return {
    info: {
      id: opts.id ?? randomId("msg"),
      sessionID: opts.sessionID ?? "ses_a",
      role: opts.role,
      time: { created: at, completed },
      agent: opts.agent,
    },
    parts: opts.parts ?? (opts.text != null ? [textPart(opts.text)] : []),
  }
}

export function userMsg(text: string, extra: Omit<Parameters<typeof ocMessage>[0], "role" | "text"> = {}): OcMessage {
  return ocMessage({ role: "user", text, ...extra })
}

export function assistantMsg(text: string, extra: Omit<Parameters<typeof ocMessage>[0], "role" | "text"> = {}): OcMessage {
  return ocMessage({ role: "assistant", text, ...extra })
}

export function stored(id: string, seq: number, role: string, text: string, extra: Partial<StoredPart> = {}): { msg: StoredMessage; part: StoredPart } {
  return {
    msg: { id, seq, role, created_at: T0 + seq * 1000, agent: null },
    part: {
      id: extra.id ?? `${id}_p`,
      message_id: id,
      type: extra.type ?? "text",
      tool: extra.tool ?? null,
      text,
      flags: extra.flags ?? null,
      suppressed: extra.suppressed ?? 0,
    },
  }
}

export function sourceTextOf(parts: StoredPart[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const p of parts) {
    if (p.suppressed) continue
    m.set(p.message_id, `${m.get(p.message_id) ?? ""}\n${p.text}`)
  }
  return m
}

export type Scripted = unknown | Error | ((req: RunRequest, signal: AbortSignal) => unknown | Error | Promise<unknown | Error>)

export class FakeRunner implements ModelRunner {
  readonly id = "fake"
  readonly requests: RunRequest[] = []
  private readonly queue: Scripted[] = []
  private fallback: Scripted | undefined

  enqueue(...replies: Scripted[]) {
    this.queue.push(...replies)
    return this
  }

  always(reply: Scripted) {
    this.fallback = reply
    return this
  }

  async run(req: RunRequest, signal: AbortSignal): Promise<RunResult> {
    this.requests.push(req)
    if (signal.aborted) throw new RunnerError("aborted", "aborted")
    const next = this.queue.length ? this.queue.shift()! : this.fallback
    if (next === undefined) throw new Error("FakeRunner: no scripted output")
    const value = typeof next === "function" ? await next(req, signal) : next
    if (value instanceof Error) throw value
    return { output: value, inputTokens: 10, outputTokens: 20, cost: 0.001, model: "fake" }
  }
}

export function observerOutput(
  observations: Array<{
    kind?: string
    content: string
    confidence?: number
    evidenceType?: string
    priority?: string
    sources: { start: string; end: string }
    quote?: string | null
    scopeHint?: string
    payload?: Record<string, unknown>
    eventAt?: string
  }>,
  extra: { currentTask?: string; suggestedNext?: string } = {},
) {
  return {
    observations: observations.map((o) => ({
      kind: o.kind ?? "fact",
      content: o.content,
      confidence: o.confidence ?? 0.9,
      evidenceType: o.evidenceType ?? "observed",
      priority: o.priority ?? "medium",
      sources: o.sources,
      quote: o.quote,
      scopeHint: o.scopeHint ?? "session",
      payload: o.payload,
      eventAt: o.eventAt,
    })),
    currentTask: extra.currentTask ?? "working on tests",
    suggestedNext: extra.suggestedNext ?? "keep going",
  }
}

export const silent: LogFn = () => {}

export async function openDb(path = ":memory:"): Promise<Database> {
  const db = await openDatabase(path)
  migrate(db)
  return db
}

export async function openHarness(opts: { file?: boolean; config?: MemoryConfig } = {}) {
  const dir = tempDir()
  const config = opts.config ?? defaultConfig(dir)
  const db = await openDb(opts.file ? join(dir, "memory.db") : ":memory:")
  return {
    dir,
    config,
    db,
    close() {
      db.close()
      cleanupDir(dir)
    },
  }
}

export function seed(
  db: Database,
  p: {
    projectId?: string
    workspace?: string
    sessionId?: string
    domain?: string
    directory?: string
    now?: number
    title?: string
  } = {},
) {
  const projectId = p.projectId ?? "proj_a"
  const workspace = p.workspace ?? "learn"
  const sessionId = p.sessionId ?? "ses_a"
  const now = p.now ?? T0
  upsertProject(db, { id: projectId, workspace, domain: p.domain ?? "learning", name: p.projectId ?? "A", directory: p.directory ?? `/tmp/${projectId}` }, now)
  upsertSession(db, { id: sessionId, projectId, title: p.title ?? sessionId }, now)
  return { projectId, workspace, sessionId, now }
}

export function ingest(db: Database, sessionId: string, messages: OcMessage[], extra: Partial<IngestOptions> = {}) {
  return ingestMessages(db, sessionId, messages, { ...CAPTURE, now: T0, ...extra })
}

export function putObservation(
  db: Database,
  o: {
    id?: string
    scopeKind?: ScopeKind
    sessionId?: string | null
    projectId?: string | null
    workspace: string
    kind?: string
    content: string
    status?: string
    evidenceType?: string
    confidence?: number
    payload?: Payload
    sources?: SourceRange[]
    actor?: string
    now?: number
    reviewReason?: string | null
    targetScope?: string | null
  },
) {
  const now = o.now ?? T0
  const id = o.id ?? randomId("obs")
  const row: NewObservation = {
    id,
    scopeKind: o.scopeKind ?? "project",
    sessionId: o.sessionId ?? null,
    projectId: o.projectId ?? null,
    workspace: o.workspace,
    chunkId: null,
    kind: o.kind ?? "fact",
    content: o.content,
    eventAt: now,
    observedAt: now,
    confidence: o.confidence ?? 0.8,
    evidenceType: o.evidenceType ?? "observed",
    priority: "medium",
    status: o.status ?? "active",
    reviewReason: o.reviewReason,
    targetScope: o.targetScope,
    payload: o.payload,
    actor: o.actor ?? "test",
    sources: o.sources ?? [],
  }
  return { id, result: insertObservation(db, row) }
}

export function makeAdapter(
  runner: ModelRunner,
  opts: {
    id?: string
    directory?: string
    project?: ProjectInfo & { excluded?: boolean }
    messages?: OcMessage[] | (() => OcMessage[])
    fetchSession?: InstanceAdapter["fetchSession"]
  } = {},
): InstanceAdapter {
  const directory = opts.directory ?? "/tmp/proj_a"
  const project = opts.project ?? { id: "proj_a", workspace: "learn", domain: "learning", name: "A", directory }
  return {
    id: opts.id ?? "inst_a",
    directory,
    project,
    runner,
    fetchMessages: async () => (typeof opts.messages === "function" ? opts.messages() : (opts.messages ?? [])),
    fetchSession: opts.fetchSession,
  }
}

export async function openEngine(opts: { runner?: FakeRunner; patch?: unknown; dbPath?: string } = {}) {
  const dir = tempDir()
  const config = mergeConfig(defaultConfig(dir), opts.patch)
  const runner = opts.runner ?? new FakeRunner()
  const engine = await MemoryEngine.open(config, silent, opts.dbPath ?? join(dir, "memory.db"))
  return {
    engine,
    dir,
    config,
    runner,
    async close() {
      try {
        await engine.close()
      } catch {}
      cleanupDir(dir)
    },
  }
}

export function track(engine: MemoryEngine, adapter: InstanceAdapter, meta: SessionMeta, now = T0) {
  engine.trackSession(adapter, meta, now)
}

export { classifyError, RunnerError }
export type { MemoryConfig, Database, InstanceAdapter, SessionMeta, ScopeKind, SourceRange }
