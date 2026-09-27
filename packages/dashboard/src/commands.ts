import { ApiError } from "./api-unwrap"

export type CommandState = "pending" | "running" | "done" | "failed" | "expired"

const STATES = new Set<string>(["pending", "running", "done", "failed", "expired"])

/**
 * POST /api/flush: `{ routed: false, result }` when this server's own window ran it, `{ routed: false,
 * commandId, state: "running" }` for a local background run, `{ routed: true, commandId, state: "pending" }`
 * when it waits for the window that owns the project.
 */
export type FlushStart = { kind: "done"; chunks?: number } | { kind: "running"; commandId: number } | { kind: "queued"; commandId: number }

export type CommandStatus = { id?: number; state: CommandState | "unknown"; result?: unknown; error?: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/** The engine stores a command's result as JSON text; tolerate parsed values and invalid text. */
export function parseCommandResult(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function chunkCount(result: unknown): number | undefined {
  const r = parseCommandResult(result)
  return isObj(r) && Array.isArray(r.chunks) ? r.chunks.length : undefined
}

export function parseFlushResponse(data: unknown): FlushStart {
  if (!isObj(data)) return { kind: "done" }
  const id = num(data.commandId)
  if (id != null) {
    if (data.routed === true || data.state === "pending") return { kind: "queued", commandId: id }
    if (data.state === "running") return { kind: "running", commandId: id }
  }
  return { kind: "done", chunks: chunkCount(data.result) }
}

export function parseCommandStatus(raw: unknown): CommandStatus | undefined {
  if (!isObj(raw)) return undefined
  const state = typeof raw.state === "string" && STATES.has(raw.state) ? (raw.state as CommandState) : "unknown"
  const result = parseCommandResult(raw.result)
  let error: string | undefined
  if (isObj(result) && typeof result.error === "string") error = result.error
  else if (state === "failed" && typeof result === "string" && result) error = result
  return { id: num(raw.id), state, result, error }
}

export function isTerminal(state: CommandStatus["state"]): boolean {
  return state === "done" || state === "failed" || state === "expired"
}

function chunksText(n: number | undefined): string {
  if (n == null) return ""
  return n ? `${n} chunk${n === 1 ? "" : "s"} sent to the observer` : "nothing new to flush"
}

/** A refused flush; 409 means no live OpenCode window has the project open, so nothing could run it. */
export function flushErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) return "Flush not sent: no open OpenCode window has this project. Open it in OpenCode and try again."
  return `Flush failed: ${err instanceof Error ? err.message : String(err)}`
}

export function flushStartMessage(s: FlushStart): string {
  if (s.kind === "queued") return "Queued for the OpenCode window that owns this project"
  if (s.kind === "running") return "Flush running…"
  const text = chunksText(s.chunks)
  return text ? `Flushed: ${text}` : "Flush requested"
}

export function commandOutcome(status: CommandStatus | undefined): { tone: "ok" | "warn" | "error"; text: string } {
  switch (status?.state) {
    case "done": {
      const text = chunksText(chunkCount(status.result))
      return { tone: "ok", text: text ? `Flush finished: ${text}` : "Flush finished" }
    }
    case "failed":
      return { tone: "error", text: `Flush failed: ${status.error ?? "unknown error"}` }
    case "expired":
      return { tone: "warn", text: "Flush expired: no OpenCode window for this project picked it up" }
    case "running":
      return { tone: "ok", text: "Flush is still running in the OpenCode window that owns this project" }
    case "pending":
      return { tone: "warn", text: "Flush is still queued for the OpenCode window that owns this project" }
    default:
      return { tone: "warn", text: "Flush status is unavailable; it may still run in the OpenCode window that owns this project" }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

export type PollCommandOptions = {
  fetch: (id: number) => Promise<unknown>
  signal: AbortSignal
  intervalMs?: number
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Polls GET /api/commands/:id until a terminal state or the timeout (returns the last status seen),
 * a 404 or repeated failures (last status, possibly undefined), or abort (always undefined).
 */
export async function pollCommand(id: number, opts: PollCommandOptions): Promise<CommandStatus | undefined> {
  const interval = opts.intervalMs ?? 1500
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? abortableSleep
  const until = now() + (opts.timeoutMs ?? 30_000)
  let last: CommandStatus | undefined
  let failures = 0
  while (!opts.signal.aborted) {
    try {
      const status = parseCommandStatus(await opts.fetch(id))
      if (opts.signal.aborted) return undefined
      failures = 0
      if (status) {
        last = status
        if (isTerminal(status.state)) return status
      }
    } catch (e) {
      if (opts.signal.aborted) return undefined
      if (e instanceof ApiError && e.status === 404) return last
      if (++failures >= 3) return last
    }
    if (now() >= until) return last
    await sleep(interval, opts.signal)
  }
  return undefined
}
