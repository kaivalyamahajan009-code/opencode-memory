import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  OBSERVER_JSON_SCHEMA,
  OBSERVER_SYSTEM,
  ObserverOutputSchema,
  observerPrompt,
} from "@opencode-memory/core"

const CONFIRM_VALUE = "I_ACCEPT_LIVE_MODEL_COSTS"
const HARD_MAX_SESSIONS = 3
const HARD_MAX_COST_USD = 1
const HARD_MAX_TIME_MS = 10 * 60_000

export type RealEvalConfig = {
  live: boolean
  explicitlyDry: boolean
  serverUrl?: string
  model?: { providerID: string; modelID: string }
  maxSessions: number
  maxCostUsd: number
  timeoutMs: number
}

export type RealEvalSummary = {
  kind: "opencode-memory-real-eval"
  version: 1
  status: "dry-run" | "skipped" | "passed" | "failed"
  live: boolean
  reason?: string
  limits: { maxSessions: number; maxCostUsd: number; timeoutMs: number }
  sessions: { attempted: number; completed: number; cleaned: number }
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  checks: Array<{ name: string; passed: boolean; detail?: string }>
  durationMs: number
}

function option(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return value
}

export function parseRealConfig(args = process.argv.slice(2), env: Record<string, string | undefined> = process.env): RealEvalConfig {
  const explicitlyDry = args.includes("--dry-run") || args.includes("--validate")
  const confirmed = args.includes("--confirm-live") || env.OPENCODE_MEMORY_EVAL_CONFIRM === CONFIRM_VALUE
  const modelText = option(args, "--model") ?? env.OPENCODE_MEMORY_EVAL_MODEL
  let model: RealEvalConfig["model"]
  if (modelText) {
    const slash = modelText.indexOf("/")
    if (slash <= 0 || slash === modelText.length - 1) throw new Error("--model must be provider/model")
    model = { providerID: modelText.slice(0, slash), modelID: modelText.slice(slash + 1) }
  }
  const maxSessions = Math.floor(
    boundedNumber(option(args, "--sessions") ?? env.OPENCODE_MEMORY_EVAL_MAX_SESSIONS, 1, 1, HARD_MAX_SESSIONS, "sessions"),
  )
  const maxCostUsd = boundedNumber(
    option(args, "--max-cost-usd") ?? env.OPENCODE_MEMORY_EVAL_MAX_COST_USD,
    0.05,
    0,
    HARD_MAX_COST_USD,
    "max cost",
  )
  const timeoutMs = Math.floor(
    boundedNumber(
      option(args, "--timeout-ms") ?? env.OPENCODE_MEMORY_EVAL_TIMEOUT_MS,
      120_000,
      1_000,
      HARD_MAX_TIME_MS,
      "timeout",
    ),
  )
  return {
    live: confirmed && !explicitlyDry,
    explicitlyDry,
    serverUrl: option(args, "--server") ?? env.OPENCODE_URL ?? env.OPENCODE_SERVER_URL,
    model,
    maxSessions,
    maxCostUsd,
    timeoutMs,
  }
}

function unwrap<T>(value: any): T {
  return (value && typeof value === "object" && "data" in value ? value.data : value) as T
}

function usageFromMessages(messages: any[]): { inputTokens: number; outputTokens: number; costUsd: number } {
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  for (const message of messages) {
    const info = message?.info ?? {}
    if (info.role !== "assistant") continue
    inputTokens += Number(info.tokens?.input ?? 0) + Number(info.tokens?.cache?.read ?? 0) + Number(info.tokens?.cache?.write ?? 0)
    outputTokens += Number(info.tokens?.output ?? 0) + Number(info.tokens?.reasoning ?? 0)
    costUsd += Number(info.cost ?? 0)
  }
  return { inputTokens, outputTokens, costUsd }
}

function skippedReason(error: unknown): string | undefined {
  const text = String((error as Error)?.message ?? error).toLowerCase()
  if (/fetch failed|econnrefused|enotfound|network|connect|socket/.test(text)) return "OpenCode connection unavailable"
  if (/401|403|unauthorized|forbidden|provider.?auth|api key|credential/.test(text)) return "OpenCode or model credentials unavailable"
  return undefined
}

export async function runRealEval(options: {
  args?: string[]
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
} = {}): Promise<RealEvalSummary> {
  const started = (options.now ?? Date.now)()
  const base = {
    kind: "opencode-memory-real-eval" as const,
    version: 1 as const,
    sessions: { attempted: 0, completed: 0, cleaned: 0 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    checks: [] as RealEvalSummary["checks"],
  }
  let config: RealEvalConfig
  try {
    config = parseRealConfig(options.args, options.env)
  } catch (error) {
    return {
      ...base,
      status: "failed",
      live: false,
      reason: String((error as Error).message),
      limits: { maxSessions: 0, maxCostUsd: 0, timeoutMs: 0 },
      durationMs: (options.now ?? Date.now)() - started,
    }
  }
  const limits = { maxSessions: config.maxSessions, maxCostUsd: config.maxCostUsd, timeoutMs: config.timeoutMs }
  if (!config.live) {
    return {
      ...base,
      status: config.explicitlyDry ? "dry-run" : "skipped",
      live: false,
      reason: config.explicitlyDry
        ? "configuration valid; live calls disabled by --dry-run/--validate"
        : `live calls require --confirm-live or OPENCODE_MEMORY_EVAL_CONFIRM=${CONFIRM_VALUE}`,
      limits,
      checks: [{ name: "configuration", passed: true, detail: "no network or model call made" }],
      durationMs: (options.now ?? Date.now)() - started,
    }
  }
  if (!config.serverUrl) {
    return {
      ...base,
      status: "skipped",
      live: false,
      reason: "live confirmation present, but OPENCODE_URL/--server is not configured",
      limits,
      durationMs: (options.now ?? Date.now)() - started,
    }
  }

  let server: URL
  try {
    server = new URL(config.serverUrl)
    if (server.protocol !== "http:" && server.protocol !== "https:") throw new Error("server must use http or https")
  } catch (error) {
    return {
      ...base,
      status: "failed",
      live: false,
      reason: `invalid OpenCode server URL: ${String((error as Error).message)}`,
      limits,
      durationMs: (options.now ?? Date.now)() - started,
    }
  }

  const root = mkdtempSync(join(tmpdir(), "om-real-eval-"))
  const project = join(root, "project")
  const memoryData = join(root, "memory-data")
  mkdirSync(join(project, ".opencode"), { recursive: true })
  mkdirSync(memoryData, { recursive: true })
  writeFileSync(
    join(project, ".opencode", "memory.json"),
    JSON.stringify({ workspace: `real-eval-${process.pid}-${started}`, domain: "general", name: "OpenCode memory real eval" }),
  )
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  timer.unref?.()
  const created = new Set<string>()
  const auth = options.env?.OPENCODE_MEMORY_EVAL_AUTH ?? process.env.OPENCODE_MEMORY_EVAL_AUTH
  const request = async <T>(method: string, path: string, body?: unknown, signal = controller.signal): Promise<T> => {
    const url = new URL(path, server)
    url.searchParams.set("directory", project)
    const response = await fetchImpl(url, {
      method,
      signal,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(auth ? { authorization: auth } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let value: unknown
    try {
      value = text ? JSON.parse(text) : undefined
    } catch {
      value = text
    }
    if (!response.ok) throw new Error(`OpenCode ${method} ${url.pathname} returned ${response.status}: ${String(text).slice(0, 300)}`)
    return unwrap<T>(value)
  }

  try {
    for (let index = 0; index < config.maxSessions; index++) {
      if (base.usage.costUsd >= config.maxCostUsd) break
      base.sessions.attempted++
      let sessionId: string | undefined
      try {
        const session = await request<{ id: string }>("POST", "/session", { title: `[memory eval] ${index + 1}` })
        if (!session?.id) throw new Error("OpenCode did not return a session id")
        sessionId = session.id
        created.add(sessionId)
        const sentinel = `deterministic-eval-${index + 1}`
        const transcript = `[m1] user @ ${new Date(started).toISOString()}\nThe user explicitly prefers ${sentinel} for acceptance testing.`
        const prompt = observerPrompt({ transcript, knownContext: "" })
        const message = await request<any>("POST", `/session/${encodeURIComponent(sessionId)}/message`, {
          agent: "om-observer",
          ...(config.model ? { model: config.model } : {}),
          parts: [{ type: "text", text: prompt }],
          format: { type: "json_schema", schema: OBSERVER_JSON_SCHEMA, retryCount: 2 },
          system: OBSERVER_SYSTEM,
        })
        const structured = message?.info?.structured
        const parsed = ObserverOutputSchema.safeParse(structured)
        base.checks.push({
          name: `session-${index + 1}-structured-output`,
          passed: parsed.success,
          detail: parsed.success ? `${parsed.data.observations.length} observations` : parsed.error.issues[0]?.message,
        })
        const containsSentinel =
          parsed.success &&
          parsed.data.observations.some((item: any) => typeof item?.content === "string" && item.content.toLowerCase().includes(sentinel))
        base.checks.push({ name: `session-${index + 1}-semantic-recall`, passed: !!containsSentinel })
        const messages = await request<any[]>("GET", `/session/${encodeURIComponent(sessionId)}/message`)
        const usage = usageFromMessages(Array.isArray(messages) ? messages : [])
        base.usage.inputTokens += usage.inputTokens
        base.usage.outputTokens += usage.outputTokens
        base.usage.costUsd += usage.costUsd
        base.sessions.completed++
        if (base.usage.costUsd > config.maxCostUsd) {
          base.checks.push({ name: "cost-bound", passed: false, detail: `reported cost ${base.usage.costUsd} exceeded ${config.maxCostUsd}` })
          break
        }
      } finally {
        if (sessionId) {
          const cleanup = new AbortController()
          const cleanupTimer = setTimeout(() => cleanup.abort(), 5_000)
          try {
            await request("DELETE", `/session/${encodeURIComponent(sessionId)}`, undefined, cleanup.signal)
            created.delete(sessionId)
            base.sessions.cleaned++
          } catch {
          } finally {
            clearTimeout(cleanupTimer)
          }
        }
      }
    }
    const allPassed = base.checks.length > 0 && base.checks.every((check) => check.passed)
    return {
      ...base,
      status: allPassed ? "passed" : "failed",
      live: true,
      ...(!allPassed ? { reason: "one or more real-eval checks failed" } : {}),
      limits,
      durationMs: (options.now ?? Date.now)() - started,
    }
  } catch (error) {
    const reason = skippedReason(error)
    return {
      ...base,
      status: reason ? "skipped" : "failed",
      live: true,
      reason: reason ?? String((error as Error).message),
      limits,
      durationMs: (options.now ?? Date.now)() - started,
    }
  } finally {
    clearTimeout(timer)
    for (const id of created) {
      const cleanup = new AbortController()
      const cleanupTimer = setTimeout(() => cleanup.abort(), 5_000)
      try {
        await request("DELETE", `/session/${encodeURIComponent(id)}`, undefined, cleanup.signal)
        base.sessions.cleaned++
      } catch {
      } finally {
        clearTimeout(cleanupTimer)
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

if (import.meta.main) {
  const summary = await runRealEval()
  console.log(JSON.stringify(summary))
  if (summary.status === "failed") process.exitCode = 1
}
