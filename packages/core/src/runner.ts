import type { FailureClass } from "./chunks"
import type { ModelRef } from "./config"

export type RunRequest = {
  purpose: "observe" | "reflect"
  agent: "om-observer" | "om-reflector"
  system: string
  prompt: string
  schema: Record<string, unknown>
  /** Session to parent the worker child session under (keeps it out of top-level lists). */
  parentSessionId?: string
  directory?: string
  model?: ModelRef
}

export type RunResult = {
  output: unknown
  inputTokens: number
  outputTokens: number
  cost: number
  model: string
}

export interface ModelRunner {
  readonly id: string
  run(req: RunRequest, signal: AbortSignal): Promise<RunResult>
}

export class RunnerError extends Error {
  constructor(
    readonly cls: FailureClass,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = "RunnerError"
  }
}

/** Map arbitrary provider/transport errors onto failure classes. */
export function classifyError(err: unknown): RunnerError {
  if (err instanceof RunnerError) return err
  const e = err as any
  const message = String(e?.message ?? e?.data?.message ?? e ?? "unknown error")
  const status = Number(e?.status ?? e?.statusCode ?? e?.data?.statusCode ?? e?.response?.status ?? NaN)
  const text = `${e?.name ?? ""} ${message}`.toLowerCase()
  if (e?.name === "AbortError" || text.includes("aborted")) return new RunnerError("aborted", message)
  if (status === 401 || status === 403 || text.includes("providerautherror") || text.includes("unauthorized") || text.includes("api key"))
    return new RunnerError("auth", message)
  if (status === 429 || text.includes("rate limit") || text.includes("too many requests") || text.includes("quota")) {
    const ra = Number(e?.responseHeaders?.["retry-after"] ?? e?.data?.responseHeaders?.["retry-after"])
    return new RunnerError("rate_limit", message, Number.isFinite(ra) ? ra * 1000 : undefined)
  }
  if (
    status === 413 ||
    text.includes("context length") ||
    text.includes("context_length") ||
    text.includes("maximum context") ||
    text.includes("too long") ||
    text.includes("messageoutputlengtherror") ||
    text.includes("prompt is too long")
  )
    return new RunnerError("oversize", message)
  if (text.includes("structuredoutput") || text.includes("did not produce structured output") || text.includes("schema"))
    return new RunnerError("invalid_output", message)
  if (status >= 500 || text.includes("timeout") || text.includes("econnreset") || text.includes("fetch failed") || text.includes("network"))
    return new RunnerError("transient", message)
  return new RunnerError("transient", message)
}
