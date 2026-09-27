import type { MemoryConfigView } from "./types"

export type SettingsDraft = {
  activationTokens: string
  bufferTokens: string
  reflectTokens: string
  dailyCapUsd: string
  dailyTokenCap: string
  runnerKind: string
  providerID: string
  modelID: string
  budgetSession: string
  budgetRecall: string
  pruning: boolean
  keepRecentTurns: string
  /** Timers in ms (each ≥ MIN_TIMER_MS). Undefined leaves the setting alone; an empty reflector timeout follows the runner. */
  runnerTimeoutMs?: string
  reflectorTimeoutMs?: string
  leaseMs?: string
}

/** Same floor as core `MIN_TIMER_MS`; the server refuses smaller timers with 400. */
export const MIN_TIMER_MS = 1000

/** Draft field for each timer config key, used to place a server-side timer refusal under its input. */
export const TIMER_FIELDS: Record<string, "runnerTimeoutMs" | "reflectorTimeoutMs" | "leaseMs"> = {
  "runner.timeoutMs": "runnerTimeoutMs",
  "reflectorRunner.timeoutMs": "reflectorTimeoutMs",
  "observe.leaseMs": "leaseMs",
}

/** The draft field a config-save refusal is about (a timer under the minimum), if it names one. */
export function serverFieldError(message: string): { key: string; text: string } | undefined {
  if (!/at least|too small|>=/i.test(message)) return undefined
  for (const [path, key] of Object.entries(TIMER_FIELDS)) {
    if (message.includes(path)) return { key, text: `Must be at least ${MIN_TIMER_MS} ms` }
  }
  return undefined
}

export type ParseNum = { ok: true; value: number } | { ok: false; error: string }

export function parseTimer(raw: string): ParseNum {
  const r = parseNumber(raw, { integer: true })
  if (!r.ok) return r
  if (r.value < MIN_TIMER_MS) return { ok: false, error: `Must be at least ${MIN_TIMER_MS} ms` }
  return r
}

export function parseNumber(raw: string, opts: { allowZero?: boolean; integer?: boolean } = {}): ParseNum {
  const t = raw.trim()
  if (!t) return { ok: false, error: "Required" }
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { ok: false, error: "Enter a number" }
  const n = Number(t)
  if (!Number.isFinite(n)) return { ok: false, error: "Enter a finite number" }
  if (opts.integer && !Number.isInteger(n)) return { ok: false, error: "Enter a whole number" }
  if (opts.allowZero) {
    if (n < 0) return { ok: false, error: "Must be zero or greater" }
  } else if (n <= 0) {
    return { ok: false, error: "Must be greater than zero" }
  }
  return { ok: true, value: n }
}

export const SETTINGS_SENSITIVE = new Set([
  "allowedOrigins",
  "port",
  "dataDir",
  "vaultDir",
  "baseURL",
  "apiKeyEnv",
  "headers",
])

export function buildSettingsPatch(
  draft: SettingsDraft,
  current: MemoryConfigView | undefined,
): { ok: true; patch: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const pos = (key: string, raw: string, integer = true) => {
    const r = parseNumber(raw, { integer })
    if (!r.ok) errors[key] = r.error
    return r.ok ? r.value : undefined
  }
  const zed = (key: string, raw: string, integer = false) => {
    const r = parseNumber(raw, { allowZero: true, integer })
    if (!r.ok) errors[key] = r.error
    return r.ok ? r.value : undefined
  }

  const activationTokens = zed("activationTokens", draft.activationTokens, true)
  const bufferTokens = pos("bufferTokens", draft.bufferTokens)
  const reflectTokens = pos("reflectTokens", draft.reflectTokens)
  const dailyCapUsd = zed("dailyCapUsd", draft.dailyCapUsd, false)
  const dailyTokenCap = pos("dailyTokenCap", draft.dailyTokenCap)
  const budgetSession = pos("budgetSession", draft.budgetSession)
  const budgetRecall = pos("budgetRecall", draft.budgetRecall)
  const keepRecentTurns = zed("keepRecentTurns", draft.keepRecentTurns, true)
  const timer = (key: string, raw: string | undefined, optional = false) => {
    if (raw === undefined || (optional && !raw.trim())) return undefined
    const r = parseTimer(raw)
    if (!r.ok) errors[key] = r.error
    return r.ok ? r.value : undefined
  }
  const runnerTimeoutMs = timer("runnerTimeoutMs", draft.runnerTimeoutMs)
  const reflectorTimeoutMs = timer("reflectorTimeoutMs", draft.reflectorTimeoutMs, true)
  const leaseMs = timer("leaseMs", draft.leaseMs)

  if (Object.keys(errors).length) return { ok: false, errors }

  const patch: Record<string, unknown> = {}
  const observe: Record<string, number> = {}
  if (activationTokens != null && activationTokens !== current?.observe?.activationTokens) observe.activationTokens = activationTokens
  if (bufferTokens != null && bufferTokens !== current?.observe?.bufferTokens) observe.bufferTokens = bufferTokens
  if (leaseMs != null && leaseMs !== current?.observe?.leaseMs) observe.leaseMs = leaseMs
  if (Object.keys(observe).length) patch.observe = observe

  if (reflectTokens != null && reflectTokens !== current?.reflect?.thresholdTokens) patch.reflect = { thresholdTokens: reflectTokens }

  const cost: Record<string, number> = {}
  if (dailyCapUsd != null && dailyCapUsd !== current?.cost?.dailyCapUsd) cost.dailyCapUsd = dailyCapUsd
  if (dailyTokenCap != null && dailyTokenCap !== current?.cost?.dailyTokenCap) cost.dailyTokenCap = dailyTokenCap
  if (Object.keys(cost).length) patch.cost = cost

  const runner: Record<string, unknown> = {}
  if (draft.runnerKind && draft.runnerKind !== current?.runner?.kind) runner.kind = draft.runnerKind
  const curProv = current?.runner?.model?.providerID ?? ""
  const curModel = current?.runner?.model?.modelID ?? ""
  if (draft.providerID !== curProv || draft.modelID !== curModel) {
    if (draft.providerID && draft.modelID) runner.model = { providerID: draft.providerID, modelID: draft.modelID }
  }
  if (runnerTimeoutMs != null && runnerTimeoutMs !== current?.runner?.timeoutMs) runner.timeoutMs = runnerTimeoutMs
  if (Object.keys(runner).length) patch.runner = runner
  if (reflectorTimeoutMs != null && reflectorTimeoutMs !== current?.reflectorRunner?.timeoutMs) patch.reflectorRunner = { timeoutMs: reflectorTimeoutMs }

  const budget: Record<string, number> = {}
  if (budgetSession != null && budgetSession !== current?.inject?.budget?.session) budget.session = budgetSession
  if (budgetRecall != null && budgetRecall !== current?.inject?.budget?.recall) budget.recall = budgetRecall
  if (Object.keys(budget).length) patch.inject = { budget }

  const pruning: Record<string, unknown> = {}
  if (draft.pruning !== !!current?.pruning?.enabled) pruning.enabled = draft.pruning
  if (keepRecentTurns != null && keepRecentTurns !== current?.pruning?.keepRecentTurns) pruning.keepRecentTurns = keepRecentTurns
  if (Object.keys(pruning).length) patch.pruning = pruning

  return { ok: true, patch }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function looksLikeConfig(v: unknown): v is MemoryConfigView {
  return isRecord(v) && (isRecord(v.observe) || isRecord(v.reflect) || isRecord(v.cost) || isRecord(v.runner))
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = isRecord(v) && isRecord(base[k]) ? deepMerge(base[k], v) : v
  return out
}

/**
 * The config to diff against after a successful save: the (masked) config POST /api/config
 * returned, or the previous baseline with the patch applied when the response is not a config.
 */
export function baselineAfterSave(
  previous: MemoryConfigView | undefined,
  returned: unknown,
  patch: Record<string, unknown>,
): MemoryConfigView {
  if (looksLikeConfig(returned)) return returned
  return deepMerge((previous ?? {}) as Record<string, unknown>, patch) as MemoryConfigView
}
