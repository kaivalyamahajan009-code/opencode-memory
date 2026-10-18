import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { MemoryError } from "./util"

export type Domain = "learning" | "research" | "general"

export type ModelRef = { providerID: string; modelID: string }

export type RunnerConfig = {
  kind: "opencode-session" | "direct"
  /** Model for OpenCode child sessions. Falls back to OpenCode's small_model, then the session model. */
  model?: ModelRef
  direct?: {
    baseURL: string
    model: string
    apiKeyEnv: string
    headers?: Record<string, string>
    inputCostPerMTok?: number
    outputCostPerMTok?: number
  }
  timeoutMs: number
}

export type EmbeddingConfig = {
  provider: "none" | "openai-compatible"
  baseURL?: string
  model?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  batchSize: number
}

export type MemoryConfig = {
  dataDir: string
  vaultDir: string
  port: number
  allowedOrigins: string[]
  capture: {
    captureReasoning: boolean
    observeSubagents: boolean
    snapshotToolOutputMax: number
    staleIncompleteMs: number
  }
  observe: {
    /** Fixed durable chunk boundary; reaching it queues work but does not itself run the model. */
    bufferTokens: number
    /** Automatic model activation threshold for total unobserved tokens; 0 activates immediately. */
    activationTokens: number
    maxChunkTokens: number
    minFlushTokens: number
    idleFlushMs: number
    maxUnobservedAgeMs: number
    observerToolOutputMax: number
    maxAttempts: number
    leaseMs: number
    concurrency: number
  }
  reflect: {
    thresholdTokens: number
    minNewDurable: number
  }
  inject: {
    enabled: boolean
    deadlineMs: number
    /** Agent names that get learning-domain injection, including due reviews, in every project. */
    learningAgents: string[]
    budget: {
      profile: number
      workspace: number
      project: number
      session: number
      task: number
      recall: number
    }
  }
  cost: {
    dailyCapUsd: number
    dailyTokenCap: number
    estimatePerRunUsd: number
  }
  runner: RunnerConfig
  reflectorRunner?: RunnerConfig
  embeddings: EmbeddingConfig
  pruning: {
    enabled: boolean
    keepRecentTurns: number
  }
  backup: {
    keep: number
    autoDaily: boolean
  }
}

export type ProjectMemoryConfig = {
  workspace: string
  domain: Domain
  name?: string
  exclude?: boolean
}

export function defaultDataDir(): string {
  const base = process.env.OPENCODE_MEMORY_DATA_DIR
  if (base) return base
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(xdg, "opencode-memory")
}

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdg, "opencode-memory", "config.json")
}

export function defaultConfig(dataDir = defaultDataDir()): MemoryConfig {
  return {
    dataDir,
    vaultDir: join(dataDir, "vault"),
    port: 4777,
    allowedOrigins: ["oc://renderer"],
    capture: {
      captureReasoning: false,
      observeSubagents: false,
      snapshotToolOutputMax: 64_000,
      staleIncompleteMs: 30 * 60_000,
    },
    observe: {
      bufferTokens: 6_000,
      activationTokens: 30_000,
      maxChunkTokens: 12_000,
      minFlushTokens: 150,
      idleFlushMs: 90_000,
      maxUnobservedAgeMs: 10 * 60_000,
      observerToolOutputMax: 4_000,
      maxAttempts: 3,
      leaseMs: 5 * 60_000,
      concurrency: 1,
    },
    reflect: {
      thresholdTokens: 40_000,
      minNewDurable: 25,
    },
    inject: {
      enabled: true,
      deadlineMs: 250,
      learningAgents: ["learn"],
      budget: { profile: 600, workspace: 900, project: 900, session: 2400, task: 300, recall: 900 },
    },
    cost: {
      dailyCapUsd: 1,
      dailyTokenCap: 2_000_000,
      estimatePerRunUsd: 0.01,
    },
    runner: { kind: "opencode-session", timeoutMs: 180_000 },
    embeddings: { provider: "none", batchSize: 32 },
    pruning: { enabled: false, keepRecentTurns: 4 },
    backup: { keep: 14, autoDaily: true },
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** Keys that would reach Object.prototype through assignment or spread; never copied. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

const nonNeg = z.number().finite().min(0)
const nonNegInt = z.number().int().min(0)
const posInt = z.number().int().min(1)
/** Run timeouts and leases below this abort every run or let leases lapse mid-run. */
export const MIN_TIMER_MS = 1000
const timerMs = z.number().finite().min(MIN_TIMER_MS)
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HeaderName = z
  .string()
  .refine((name) => HTTP_HEADER_NAME.test(name) && !UNSAFE_KEYS.has(name), "invalid or forbidden HTTP header name")
const HeaderValue = z.string().refine((value) => !/[\r\n]/.test(value), "HTTP header values cannot contain line breaks")
const HeaderMap = z.record(HeaderName, HeaderValue)
const ModelRefSchema = z.strictObject({ providerID: z.string().min(1), modelID: z.string().min(1) })
const RunnerPatchSchema = z.strictObject({
  kind: z.enum(["opencode-session", "direct"]).optional(),
  model: ModelRefSchema.optional(),
  direct: z
    .strictObject({
      baseURL: z.string().optional(),
      model: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      headers: HeaderMap.optional(),
      inputCostPerMTok: nonNeg.optional(),
      outputCostPerMTok: nonNeg.optional(),
    })
    .optional(),
  timeoutMs: timerMs.optional(),
})

/**
 * Deep-partial MemoryConfig: every section optional, primitives type-checked,
 * unknown keys (including `__proto__` / `constructor`) and null sections rejected.
 * Used for untrusted patches and, per section, for config.json on load.
 */
const CONFIG_SECTIONS = {
  dataDir: z.string().min(1),
  vaultDir: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  allowedOrigins: z.array(z.string()),
  capture: z.strictObject({
    captureReasoning: z.boolean().optional(),
    observeSubagents: z.boolean().optional(),
    snapshotToolOutputMax: nonNegInt.optional(),
    staleIncompleteMs: nonNeg.optional(),
  }),
  observe: z.strictObject({
    bufferTokens: nonNegInt.optional(),
    activationTokens: nonNegInt.optional(),
    maxChunkTokens: posInt.optional(),
    minFlushTokens: nonNegInt.optional(),
    idleFlushMs: nonNeg.optional(),
    maxUnobservedAgeMs: nonNeg.optional(),
    observerToolOutputMax: nonNegInt.optional(),
    maxAttempts: posInt.optional(),
    leaseMs: timerMs.optional(),
    concurrency: posInt.optional(),
  }),
  reflect: z.strictObject({ thresholdTokens: nonNegInt.optional(), minNewDurable: nonNegInt.optional() }),
  inject: z.strictObject({
    enabled: z.boolean().optional(),
    deadlineMs: nonNeg.optional(),
    learningAgents: z.array(z.string().min(1)).optional(),
    budget: z
      .strictObject({
        profile: nonNegInt.optional(),
        workspace: nonNegInt.optional(),
        project: nonNegInt.optional(),
        session: nonNegInt.optional(),
        task: nonNegInt.optional(),
        recall: nonNegInt.optional(),
      })
      .optional(),
  }),
  cost: z.strictObject({ dailyCapUsd: nonNeg.optional(), dailyTokenCap: nonNeg.optional(), estimatePerRunUsd: nonNeg.optional() }),
  runner: RunnerPatchSchema,
  reflectorRunner: RunnerPatchSchema,
  embeddings: z.strictObject({
    provider: z.enum(["none", "openai-compatible"]).optional(),
    baseURL: z.string().optional(),
    model: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    headers: HeaderMap.optional(),
    batchSize: posInt.optional(),
  }),
  pruning: z.strictObject({ enabled: z.boolean().optional(), keepRecentTurns: nonNegInt.optional() }),
  backup: z.strictObject({ keep: nonNegInt.optional(), autoDaily: z.boolean().optional() }),
} as const

type SectionKey = keyof typeof CONFIG_SECTIONS

export const ConfigPatchSchema = z.strictObject(
  Object.fromEntries(Object.entries(CONFIG_SECTIONS).map(([k, s]) => [k, s.optional()])) as {
    [K in SectionKey]: z.ZodOptional<(typeof CONFIG_SECTIONS)[K]>
  },
)

export type ConfigPatch = z.infer<typeof ConfigPatchSchema>

function hasUnsafeKey(v: unknown, depth = 0): boolean {
  if (!v || typeof v !== "object" || depth > 8) return false
  for (const k of Object.keys(v)) {
    if (UNSAFE_KEYS.has(k)) return true
    if (hasUnsafeKey((v as Record<string, unknown>)[k], depth + 1)) return true
  }
  return false
}

/**
 * Build headers for OpenAI-compatible requests. Config validation is the primary
 * guard; these checks also make programmatically supplied config fail closed.
 * Generated protocol/auth headers are set last so custom casing cannot override them.
 */
export function openAICompatibleHeaders(custom?: Record<string, string>, apiKey?: string): globalThis.Headers {
  const headers = new globalThis.Headers()
  for (const [name, value] of Object.entries(custom ?? {})) {
    if (UNSAFE_KEYS.has(name) || !HTTP_HEADER_NAME.test(name)) throw new Error("custom headers contain an invalid name")
    if (typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("custom headers contain an invalid value")
    headers.set(name, value)
  }
  headers.set("content-type", "application/json")
  if (apiKey) {
    if (/[\r\n]/.test(apiKey)) throw new Error("authorization credential contains a forbidden line break")
    headers.set("authorization", `Bearer ${apiKey}`)
  }
  return headers
}

function safeIssuePath(path: PropertyKey[]): string {
  const header = path.indexOf("headers")
  const safe = header >= 0 ? path.slice(0, header + 1) : path
  return safe.length ? safe.join(".") : "patch"
}

/** Validate an untrusted config patch; throws MemoryError('invalid', 400) with the first issue. */
export function parseConfigPatch(patch: unknown): ConfigPatch {
  if (!isObject(patch)) throw new MemoryError("config patch must be an object", "invalid", 400)
  if (hasUnsafeKey(patch)) throw new MemoryError("config patch contains a forbidden key", "invalid", 400)
  const r = ConfigPatchSchema.safeParse(patch)
  if (!r.success) {
    const issue = r.error.issues[0]
    const where = safeIssuePath(issue?.path ?? [])
    throw new MemoryError(`invalid config ${where}: ${issue?.message ?? "invalid value"}`, "invalid", 400)
  }
  return r.data
}

export function mergeConfig<T>(base: T, patch: unknown): T {
  if (!isObject(patch)) return base
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) }
  for (const k of Object.keys(patch)) {
    if (UNSAFE_KEYS.has(k)) continue
    const v = patch[k]
    if (v === undefined) continue
    const cur = (base as any)?.[k]
    out[k] = isObject(cur) && isObject(v) ? mergeConfig(cur, v) : v
  }
  return out
}

function omit(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) if (!keys.includes(k) && !UNSAFE_KEYS.has(k)) out[k] = obj[k]
  return out
}

function stripRunnerSecrets(runner: unknown): unknown {
  if (!isObject(runner)) return runner
  const out = omit(runner, [])
  if (isObject(out.direct)) out.direct = omit(out.direct, ["apiKeyEnv", "baseURL", "headers"])
  return out
}

/** Drop bind/secret fields so an untrusted patch cannot persist them to config.json. */
export function stripSensitiveConfigPatch(patch: unknown): unknown {
  if (!isObject(patch)) return patch
  const out = omit(patch, ["dataDir", "vaultDir", "port", "allowedOrigins"])
  if (isObject(out.embeddings)) out.embeddings = omit(out.embeddings, ["apiKeyEnv", "baseURL", "headers"])
  if ("runner" in out) out.runner = stripRunnerSecrets(out.runner)
  if ("reflectorRunner" in out) out.reflectorRunner = stripRunnerSecrets(out.reflectorRunner)
  return out
}

const TIMER_FIELDS: Record<string, string> = { runner: "timeoutMs", reflectorRunner: "timeoutMs", observe: "leaseMs" }

/** A file written before the timer minimum keeps its section: small timers are raised, not rejected. */
function raiseLegacyTimers(key: string, section: unknown, warn: (msg: string) => void): unknown {
  const field = TIMER_FIELDS[key]
  if (!field || !isObject(section)) return section
  const v = section[field]
  if (typeof v !== "number" || !Number.isFinite(v) || v >= MIN_TIMER_MS) return section
  warn(`config: ${key}.${field} ${v} is below ${MIN_TIMER_MS}ms; using ${MIN_TIMER_MS}`)
  return { ...section, [field]: MIN_TIMER_MS }
}

/** Keep only file sections that validate; an invalid section falls back to defaults (with a warning). */
function validFileSections(raw: unknown, warn: (msg: string) => void): ConfigPatch {
  if (!isObject(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (UNSAFE_KEYS.has(k)) {
      warn(`config: ignoring forbidden key "${k}"`)
      continue
    }
    const schema = (CONFIG_SECTIONS as Record<string, z.ZodType>)[k]
    if (!schema) {
      warn(`config: ignoring unknown key "${k}"`)
      continue
    }
    if (hasUnsafeKey(raw[k])) {
      warn(`config: section "${k}" contains a forbidden key; using defaults`)
      continue
    }
    const r = schema.safeParse(raiseLegacyTimers(k, raw[k], warn))
    if (r.success) out[k] = r.data
    else warn(`config: invalid section "${k}" (${r.error.issues[0]?.message ?? "invalid"}); using defaults`)
  }
  return out as ConfigPatch
}

function readConfigFile(path: string, warn: (msg: string) => void): ConfigPatch {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    warn(`config: ${path} is not valid JSON; using defaults`)
    return {}
  }
  return validFileSections(raw, warn)
}

const defaultWarn = (msg: string) => console.warn(`[opencode-memory] ${msg}`)

function sanitizeRunner(current: RunnerConfig, next: RunnerConfig): RunnerConfig {
  return {
    ...next,
    direct: current.direct
      ? {
          ...(next.direct ?? current.direct),
          model: next.direct?.model ?? current.direct.model,
          inputCostPerMTok: next.direct?.inputCostPerMTok ?? current.direct.inputCostPerMTok,
          outputCostPerMTok: next.direct?.outputCostPerMTok ?? current.direct.outputCostPerMTok,
          baseURL: current.direct.baseURL,
          apiKeyEnv: current.direct.apiKeyEnv,
          headers: current.direct.headers,
        }
      : undefined,
  }
}

/**
 * Keep secret and bind-address fields from `current` so an untrusted config
 * patch cannot retarget the embedder, runner, data dirs, port, or origins.
 * `next` is validated first (throws MemoryError 'invalid'); only known keys are merged.
 */
export function sanitizeConfigPatch(current: MemoryConfig, next: unknown): MemoryConfig {
  const merged = mergeConfig(current, parseConfigPatch(next))
  merged.dataDir = current.dataDir
  merged.vaultDir = current.vaultDir
  merged.port = current.port
  merged.allowedOrigins = [...current.allowedOrigins]
  merged.embeddings = {
    ...merged.embeddings,
    apiKeyEnv: current.embeddings.apiKeyEnv,
    baseURL: current.embeddings.baseURL,
    headers: current.embeddings.headers,
  }
  merged.runner = sanitizeRunner(current.runner, merged.runner)
  if (current.reflectorRunner || merged.reflectorRunner) {
    merged.reflectorRunner = sanitizeRunner(current.reflectorRunner ?? current.runner, merged.reflectorRunner ?? merged.runner)
  }
  return merged
}

export function loadConfig(path = configPath(), warn: (msg: string) => void = defaultWarn): MemoryConfig {
  const user = readConfigFile(path, warn)
  const merged = mergeConfig(defaultConfig(user.dataDir ?? defaultDataDir()), user)
  if (user.vaultDir === undefined) merged.vaultDir = join(merged.dataDir, "vault")
  return merged
}

/** Deep copy of parsed JSON without prototype-reaching keys. */
function withoutUnsafeKeys(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => withoutUnsafeKeys(x, depth + 1))
  if (!isObject(v) || depth > 16) return v
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v)) if (!UNSAFE_KEYS.has(k)) out[k] = withoutUnsafeKeys(v[k], depth + 1)
  return out
}

/** config.json as written (unknown and invalid sections, secrets included); refuses a file it cannot merge into. */
function readRawConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new MemoryError(`${path} is not valid JSON; fix or remove it before saving settings`, "invalid", 400)
  }
  if (!isObject(raw)) throw new MemoryError(`${path} must contain a JSON object; fix or remove it before saving settings`, "invalid", 400)
  return withoutUnsafeKeys(raw) as Record<string, unknown>
}

/**
 * Validate (throws MemoryError 'invalid'), strip bind/secret fields, merge into config.json
 * as written, and write atomically (temp file + rename). Sections the patch does not touch
 * are kept verbatim (unknown or invalid ones included, and runner/embedding secrets); a
 * patched section that would still be invalid is refused so the change is not silently ignored.
 */
export function saveConfigPatch(patch: unknown, path = configPath()): MemoryConfig {
  const safe = stripSensitiveConfigPatch(parseConfigPatch(patch)) as Record<string, unknown>
  const current = readRawConfigFile(path)
  const next = mergeConfig(current, safe)
  for (const k of Object.keys(safe)) {
    const schema = (CONFIG_SECTIONS as Record<string, z.ZodType>)[k]
    if (!schema || safe[k] === undefined) continue
    const r = schema.safeParse(raiseLegacyTimers(k, next[k], () => {}))
    if (!r.success)
      throw new MemoryError(
        `config.json section "${k}" is invalid (${r.error.issues[0]?.message ?? "invalid"}); fix it in ${path} before changing it here`,
        "invalid",
        400,
      )
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2))
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  return loadConfig(path)
}

export function loadProjectConfig(directory: string, fallbackName?: string): ProjectMemoryConfig {
  const file = join(directory, ".opencode", "memory.json")
  let raw: any = {}
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"))
    } catch {}
  }
  const domain: Domain = raw.domain === "learning" || raw.domain === "research" ? raw.domain : "general"
  const workspace = typeof raw.workspace === "string" && raw.workspace.trim() ? raw.workspace.trim() : "personal-knowledge"
  return { workspace, domain, name: typeof raw.name === "string" ? raw.name : fallbackName, exclude: raw.exclude === true }
}
