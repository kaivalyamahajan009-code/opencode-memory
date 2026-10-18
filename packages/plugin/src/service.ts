import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"
import {
  loadConfig,
  memoryGeneration,
  mergeConfig,
  MemoryEngine,
  type InstanceAdapter,
  type LogFn,
  type MemoryConfig,
  type ModelRunner,
} from "@opencode-memory/core"
import { createAdapter, sweepOrphanMemorySessions, type OcClient } from "./opencode-adapter"
import { LruMap } from "./lru"
import { DirectRunner } from "./runners/direct"
import { FakeRunner, type FakeOutput } from "./runners/fake"
import { createdRunnerSession, isRunnerSession, OpenCodeSessionRunner } from "./runners/opencode-session"
import { listenMemoryHttp, type MemoryHttp } from "./server/http"

export const SERVICE_KEY = Symbol.for("opencode-memory.service")
const CLOSING_KEY = Symbol.for("opencode-memory.service.closing")
const SESSION_MAPS_MAX = 200

export type MemoryPluginOptions = {
  dataDir?: string
  port?: number
  runner?: "fake" | "opencode-session" | "direct"
  fakeOutputs?: FakeOutput[]
}

/**
 * `generation` (memoryGeneration()) and `events` (eventWatermark()) are read before the block
 * was built; `ids` are the observations in it.
 */
export type InjectionMemo = {
  messageID: string
  block: string
  ids: string[]
  generation: number
  events: number
  /** Override the block was built with. Empty means the project's own domain and workspace. */
  domain: string
  workspace: string
}
export type DeadlineState = { misses: number; until: number }

const ALTERING_EVENTS = ["forgotten", "rejected", "edited", "superseded", "condensed", "hidden", "expired"]
const ID_BATCH = 400

/** Newest observation_events id: "altered after the block was built" is measured against this, not memoryGeneration(). */
export function eventWatermark(db: MemoryEngine["db"]): number {
  return db.prepare("SELECT COALESCE(MAX(id), 0) AS g FROM observation_events").get<{ g: number }>()!.g
}

/**
 * Whether a memoized block may be sent again. Changes made through this process clear the
 * memo directly; this catches ones made by another process sharing the database: any
 * observation in the block that is no longer active and visible, or that was altered after
 * the block was built. New observations alone do not invalidate it, so the block stays
 * stable for the rest of the turn.
 */
export function memoFresh(engine: MemoryEngine, memo: InjectionMemo): boolean {
  const now = memoryGeneration(engine.db)
  if (now === memo.generation) return true
  if (now < memo.generation) return false
  const events = eventWatermark(engine.db)
  if (events < memo.events) return false
  for (let i = 0; i < memo.ids.length; i += ID_BATCH) {
    const ids = memo.ids.slice(i, i + ID_BATCH)
    const marks = ids.map(() => "?").join(",")
    const live = engine.db
      .prepare(`SELECT COUNT(*) AS n FROM observations WHERE id IN (${marks}) AND status IN ('active','pending_review') AND visibility = 'visible'`)
      .get<{ n: number }>(...ids)!.n
    if (live !== ids.length) return false
    const altered = engine.db
      .prepare(
        `SELECT 1 FROM observation_events WHERE id > ? AND observation_id IN (${marks}) AND type IN (${ALTERING_EVENTS.map(() => "?").join(",")}) LIMIT 1`,
      )
      .get(memo.events, ...ids, ...ALTERING_EVENTS)
    if (altered) return false
  }
  memo.generation = now
  memo.events = events
  return true
}

/** Engine calls that change what an injected block would contain. */
const INVALIDATING = [
  "forget",
  "forgetSession",
  "restore",
  "edit",
  "supersede",
  "approve",
  "reject",
  "approvePromotion",
  "resolveReview",
  "approveTopic",
  "rollbackTopic",
  "pin",
  "onRevert",
  "onUnrevert",
  "updateConfig",
  "setPaused",
  "setSessionFlag",
] as const

/** Run `clear` after each invalidating engine call made through this process, even when the call throws. */
export function invalidateMemoOn(engine: MemoryEngine, clear: () => void) {
  const target = engine as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of INVALIDATING) {
    const orig = target[name]
    if (typeof orig !== "function") continue
    const bound = orig.bind(engine)
    target[name] = (...args: unknown[]) => {
      let out: unknown
      try {
        out = bound(...args)
      } catch (e) {
        clear()
        throw e
      }
      if (out instanceof Promise) return out.finally(clear)
      clear()
      return out
    }
  }
}

export type ServiceState = {
  engine: MemoryEngine
  http?: MemoryHttp
  token: string
  refs: number
  lastUser: LruMap<string, string>
  /** Per session: agent from the latest chat.message or chat.params. system.transform has no agent of its own. */
  agent: LruMap<string, string>
  /** Per session: the block built for the current user message, reused for every step of that turn. */
  injectionMemo: LruMap<string, InjectionMemo>
  currentUserMessage: LruMap<string, string>
  /** Per session: the user message whose block was actually pushed into the system prompt. */
  injected: LruMap<string, string>
  deadlineMisses: LruMap<string, DeadlineState>
}

type ServiceSlot = {
  promise: Promise<ServiceState>
  state?: ServiceState
}

type GlobalHold = typeof globalThis & { [SERVICE_KEY]?: ServiceSlot; [CLOSING_KEY]?: Promise<void> }

export function getMemoryService(): ServiceState | undefined {
  return (globalThis as GlobalHold)[SERVICE_KEY]?.state
}

function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function loadOrCreateToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = join(dataDir, "token")
  const read = () => {
    try {
      return readFileSync(file, "utf8").trim()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw e
    }
  }
  const existing = read()
  if (existing) return existing
  const token = randomBytes(32).toString("hex")
  if (existing === undefined) {
    try {
      writeFileSync(file, token, { encoding: "utf8", mode: 0o600, flag: "wx" })
      return token
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
    }
  }
  for (let i = 0; i < 5; i++) {
    const again = read()
    if (again) return again
    pause(20)
  }
  writeFileSync(file, token, { encoding: "utf8", mode: 0o600, flag: "w" })
  return token
}

export function resolveDashboardDir(metaUrl: string): string {
  const here = dirname(fileURLToPath(metaUrl))
  const candidates = [join(here, "dashboard"), join(here, "..", "dashboard", "dist"), join(here, "..", "..", "dashboard", "dist")]
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c
  return candidates[0]!
}

export function applyOverrides(base: MemoryConfig, options?: MemoryPluginOptions): MemoryConfig {
  const patch: Record<string, unknown> = {}
  if (options?.dataDir) {
    patch.dataDir = options.dataDir
    patch.vaultDir = join(options.dataDir, "vault")
  }
  if (typeof options?.port === "number") patch.port = options.port
  return mergeConfig(base, patch)
}

function runnerKind(config: MemoryConfig, options?: MemoryPluginOptions, which: "observer" | "reflector" = "observer"): "fake" | "opencode-session" | "direct" {
  if (options?.runner === "fake" || options?.runner === "direct" || options?.runner === "opencode-session") return options.runner
  if (which === "reflector") return (config.reflectorRunner?.kind ?? config.runner.kind) as "opencode-session" | "direct"
  return config.runner.kind
}

export function createRunner(
  kind: "fake" | "opencode-session" | "direct",
  client: OcClient,
  engine: MemoryEngine,
  directory: string,
  getConfig: () => MemoryConfig,
  fakeOutputs?: FakeOutput[],
  which: "runner" | "reflectorRunner" = "runner",
): ModelRunner {
  if (kind === "fake") return new FakeRunner(fakeOutputs)
  if (kind === "direct") return new DirectRunner(getConfig, which)
  return new OpenCodeSessionRunner(client, engine, directory)
}

type RunnerKind = "fake" | "opencode-session" | "direct"

/** Resolves the runner kind from the live config on every call so a config change applies without a restart. */
export function liveRunner(pick: () => RunnerKind, make: (kind: RunnerKind) => ModelRunner): ModelRunner {
  const made = new Map<RunnerKind, ModelRunner>()
  const current = () => {
    const kind = pick()
    let r = made.get(kind)
    if (!r) {
      r = make(kind)
      made.set(kind, r)
    }
    return r
  }
  return {
    get id() {
      return current().id
    },
    run: (req, signal) => current().run(req, signal),
  }
}

async function bootService(options: MemoryPluginOptions | undefined, log: LogFn): Promise<ServiceState> {
  const g = globalThis as GlobalHold
  await g[CLOSING_KEY]?.catch(() => {})
  const config = applyOverrides(loadConfig(), options)
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const engine = await MemoryEngine.open(config, log)
  const token = loadOrCreateToken(config.dataDir)
  let http: MemoryHttp
  try {
    http = await listenMemoryHttp(engine, {
      token,
      dashboardDir: resolveDashboardDir(import.meta.url),
      log,
    })
  } catch (e) {
    await engine.close().catch(() => {})
    throw e
  }
  const state: ServiceState = {
    engine,
    http,
    token,
    refs: 0,
    lastUser: new LruMap(SESSION_MAPS_MAX),
    agent: new LruMap(SESSION_MAPS_MAX),
    injectionMemo: new LruMap(SESSION_MAPS_MAX),
    currentUserMessage: new LruMap(SESSION_MAPS_MAX),
    injected: new LruMap(SESSION_MAPS_MAX),
    deadlineMisses: new LruMap(SESSION_MAPS_MAX),
  }
  invalidateMemoOn(engine, () => state.injectionMemo.clear())
  return state
}

export async function acquireService(
  input: { client: OcClient; directory: string; project: { id: string } },
  options: MemoryPluginOptions | undefined,
  log: LogFn,
): Promise<{ state: ServiceState; adapter: InstanceAdapter; release: () => Promise<void> }> {
  const g = globalThis as GlobalHold
  let slot = g[SERVICE_KEY]
  if (!slot) {
    const created: ServiceSlot = {
      promise: bootService(options, log).then((state) => {
        created.state = state
        return state
      }),
    }
    g[SERVICE_KEY] = slot = created
    created.promise.catch(() => {
      if (g[SERVICE_KEY] === created) delete g[SERVICE_KEY]
    })
  }
  const owned = slot
  const state = owned.state ?? (await owned.promise)
  state.refs++
  const getConfig = () => state.engine.config
  const runner = liveRunner(
    () => runnerKind(getConfig(), options, "observer"),
    (kind) => createRunner(kind, input.client, state.engine, input.directory, getConfig, options?.fakeOutputs, "runner"),
  )
  const reflectRunner = liveRunner(
    () => runnerKind(getConfig(), options, "reflector"),
    (kind) => createRunner(kind, input.client, state.engine, input.directory, getConfig, options?.fakeOutputs, "reflectorRunner"),
  )
  const adapter = createAdapter({
    client: input.client,
    directory: input.directory,
    project: input.project,
    runner,
    reflectRunner,
    fallbackName: input.directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop(),
  })
  state.engine.register(adapter)
  void sweepOrphanMemorySessions(input.client, input.directory, log, isRunnerSession, createdRunnerSession).catch((e) =>
    log("warn", `orphan sweep failed: ${String(e)}`),
  )
  let released = false
  const release = async () => {
    if (released) return
    released = true
    try {
      state.engine.unregister(adapter.id)
    } catch {}
    state.refs--
    if (state.refs > 0) return
    if (g[SERVICE_KEY] === owned) delete g[SERVICE_KEY]
    const closing = (async () => {
      try {
        await state.http?.close()
      } catch {}
      try {
        await state.engine.close()
      } catch {}
    })()
    g[CLOSING_KEY] = closing
    await closing
    if (g[CLOSING_KEY] === closing) delete g[CLOSING_KEY]
  }
  return { state, adapter, release }
}
