import "./hermetic"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MemoryEngine,
  RunnerError,
  defaultConfig,
  mergeConfig,
  type InstanceAdapter,
  type MemoryConfig,
  type ModelRunner,
  type OcMessage,
  type RunRequest,
  type RunResult,
} from "@opencode-memory/core"

export const T0 = 1_800_000_000_000
const dirs = new Set<string>()

export function tempDir(prefix = "om-accept-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.add(dir)
  return dir
}

export function cleanupDir(dir: string): void {
  dirs.delete(dir)
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {}
}

export function cleanupAll(): void {
  for (const dir of [...dirs]) cleanupDir(dir)
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = address && typeof address === "object" ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

export function evalConfig(dataDir: string, patch: unknown = {}): MemoryConfig {
  return mergeConfig(
    defaultConfig(dataDir),
    mergeConfig(
      {
        capture: {
          captureReasoning: false,
          observeSubagents: false,
          snapshotToolOutputMax: 4_000,
          staleIncompleteMs: 60_000,
        },
        observe: {
          bufferTokens: 72,
          activationTokens: 120,
          maxChunkTokens: 48,
          minFlushTokens: 1,
          idleFlushMs: 1_000,
          maxUnobservedAgeMs: 1_000,
          observerToolOutputMax: 500,
          maxAttempts: 2,
          leaseMs: 1_000,
          concurrency: 1,
        },
        reflect: { thresholdTokens: 500, minNewDurable: 3 },
        inject: {
          enabled: true,
          deadlineMs: 2_000,
          budget: { profile: 100, workspace: 140, project: 140, session: 240, task: 60, recall: 140 },
        },
        cost: { dailyCapUsd: 1, dailyTokenCap: 50_000, estimatePerRunUsd: 0.001 },
        runner: { kind: "opencode-session", timeoutMs: 5_000 },
        embeddings: { provider: "none", batchSize: 8 },
        pruning: { enabled: true, keepRecentTurns: 2 },
        backup: { keep: 3, autoDaily: false },
      },
      patch,
    ),
  )
}

export type ScriptedReply =
  | unknown
  | Error
  | ((request: RunRequest, signal: AbortSignal, call: number) => unknown | Error | Promise<unknown | Error>)

export class ScriptedRunner implements ModelRunner {
  readonly id = "acceptance-fake"
  readonly requests: RunRequest[] = []
  private index = 0

  constructor(
    private readonly replies: ScriptedReply[] = [{ observations: [] }],
    private readonly usage: Omit<RunResult, "output"> = {
      inputTokens: 13,
      outputTokens: 7,
      cost: 0.0001,
      model: "acceptance/fake",
    },
  ) {}

  async run(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
    const call = this.index++
    this.requests.push(request)
    if (signal.aborted) throw new RunnerError("aborted", "fake runner aborted")
    const reply = this.replies[Math.min(call, this.replies.length - 1)]
    const value = typeof reply === "function" ? await reply(request, signal, call) : reply
    if (value instanceof Error) throw value
    return { output: value, ...this.usage }
  }
}

export function textPart(id: string, text: string) {
  return { id, type: "text", text }
}

export function userMessage(sessionID: string, id: string, text: string, at = T0): OcMessage {
  return {
    info: { id, sessionID, role: "user", time: { created: at, completed: at } },
    parts: [textPart(`${id}-part`, text)],
  }
}

export function assistantMessage(sessionID: string, id: string, text: string, at = T0): OcMessage {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      agent: "build",
      time: { created: at, completed: at + 1 },
    },
    parts: [textPart(`${id}-part`, text)],
  }
}

export function longMessages(sessionID: string, count = 18, words = 28): OcMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const text = `${index % 2 ? "assistant" : "user"} turn ${index} ` + `substantive-${index} `.repeat(words)
    return index % 2
      ? assistantMessage(sessionID, `a${index}`, text, T0 + index * 10)
      : userMessage(sessionID, `u${index}`, text, T0 + index * 10)
  })
}

export function outputForFirstRef(request: RunRequest, content = "The session contains durable acceptance-test context") {
  const first = request.prompt.match(/^\[(m\d+)\]/m)?.[1] ?? "m1"
  return {
    observations: [
      {
        kind: "fact",
        content,
        confidence: 0.8,
        evidenceType: "observed",
        priority: "medium",
        sources: { start: first, end: first },
        scopeHint: "session",
      },
    ],
    currentTask: "running deterministic acceptance checks",
    suggestedNext: "continue the acceptance workflow",
  }
}

export function adapter(options: {
  runner: ModelRunner
  directory: string
  id?: string
  projectId?: string
  workspace?: string
  domain?: "learning" | "research" | "general"
  messages?: OcMessage[] | (() => OcMessage[])
}): InstanceAdapter {
  const projectId = options.projectId ?? "project-a"
  return {
    id: options.id ?? `instance-${projectId}`,
    directory: options.directory,
    project: {
      id: projectId,
      workspace: options.workspace ?? "workspace-a",
      domain: options.domain ?? "general",
      name: projectId,
      directory: options.directory,
    },
    runner: options.runner,
    fetchMessages: async () => (typeof options.messages === "function" ? options.messages() : (options.messages ?? [])),
  }
}

export async function openEngine(options: {
  dir?: string
  dbPath?: string
  runner?: ModelRunner
  patch?: unknown
} = {}) {
  const dir = options.dir ?? tempDir()
  const runner = options.runner ?? new ScriptedRunner()
  const config = evalConfig(dir, options.patch)
  const dbPath = options.dbPath ?? join(dir, "memory.db")
  const engine = await MemoryEngine.open(config, () => {}, dbPath)
  return { dir, dbPath, runner, config, engine }
}

export function count(engine: MemoryEngine, table: string): number {
  if (!/^[a-z_]+$/i.test(table)) throw new Error("unsafe table name")
  return engine.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>()!.n
}
