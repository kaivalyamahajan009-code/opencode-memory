import { classifyError, RunnerError, withUsage, type MemoryEngine, type ModelRunner, type RunRequest, type RunResult } from "@opencode-memory/core"
import { LruMap } from "../lru"
import type { OcClient, SdkMessage } from "../opencode-adapter"

type Usage = Pick<RunResult, "inputTokens" | "outputTokens" | "cost" | "model">

export const OBSERVER_TITLE = "[memory] observer"
export const REFLECTOR_TITLE = "[memory] reflector"

const inFlight = new Set<string>()
const created = new LruMap<string, true>(1000)

/** Child sessions this process is currently running; the orphan sweep must leave them alone. */
export function isRunnerSession(id: string): boolean {
  return inFlight.has(id)
}

/** Child sessions this process created (a failed delete can leave one behind). */
export function createdRunnerSession(id: string): boolean {
  return created.get(id) === true
}

export function usageFromMessages(messages: SdkMessage[]): Usage {
  let inputTokens = 0
  let outputTokens = 0
  let cost = 0
  let model = "unknown"
  for (const m of messages) {
    const info = m.info ?? {}
    if (info.role !== "assistant") continue
    const t = info.tokens ?? {}
    const cache = t.cache ?? {}
    inputTokens += Number(t.input ?? 0) + Number(cache.read ?? 0) + Number(cache.write ?? 0)
    outputTokens += Number(t.output ?? 0) + Number(t.reasoning ?? 0)
    cost += Number(info.cost ?? 0)
    if (info.providerID && info.modelID) model = `${info.providerID}/${info.modelID}`
    else if (info.modelID) model = String(info.modelID)
  }
  return { inputTokens, outputTokens, cost, model }
}

export class OpenCodeSessionRunner implements ModelRunner {
  readonly id = "opencode-session"

  constructor(
    private readonly client: OcClient,
    private readonly engine: MemoryEngine,
    private readonly directory: string,
  ) {}

  private async usage(id: string, directory: string): Promise<Usage> {
    return (await this.listedUsage(id, directory)) ?? usageFromMessages([])
  }

  /** Usage of the child session, or undefined when its messages could not be listed. */
  private async listedUsage(id: string, directory: string): Promise<Usage | undefined> {
    const listed = await this.client.session.messages({ path: { id }, query: { directory } }).catch(() => undefined)
    const data = listed?.data
    return Array.isArray(data) ? usageFromMessages(data) : undefined
  }

  async run(req: RunRequest, signal: AbortSignal): Promise<RunResult> {
    if (signal.aborted) throw new RunnerError("aborted", "aborted")
    const directory = req.directory ?? this.directory
    const title = req.purpose === "reflect" ? REFLECTOR_TITLE : OBSERVER_TITLE
    const session = await this.client.session.create({
      body: { parentID: req.parentSessionId, title },
      query: { directory },
    })
    if (session.error || !session.data?.id) throw classifyError(session.error ?? new Error("session.create failed"))
    const id = session.data.id
    inFlight.add(id)
    created.set(id, true)
    this.engine.markInternal(id)
    const onAbort = () => {
      Promise.resolve()
        .then(() => this.client.session.abort({ path: { id }, query: { directory } }))
        .catch(() => {})
    }
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      const body = {
        agent: req.agent,
        model: req.model ? { providerID: req.model.providerID, modelID: req.model.modelID } : undefined,
        parts: [{ type: "text", text: req.prompt }],
        format: { type: "json_schema", schema: req.schema, retryCount: 2 },
      }
      const prompted = await this.client.session.prompt({
        path: { id },
        query: { directory },
        body,
        signal,
      } as any)
      if (prompted.error) throw classifyError(prompted.error)
      const info = prompted.data?.info as
        | {
            error?: { name?: string; data?: { message?: string } }
            structured?: unknown
          }
        | undefined
      if (!info) throw new RunnerError("transient", "session.prompt returned no message")
      if (info.error) {
        const name = String(info.error.name ?? "")
        const message = String(info.error.data?.message ?? name)
        if (name === "StructuredOutputError" || name.includes("StructuredOutput")) throw new RunnerError("invalid_output", message)
        if (name === "ProviderAuthError") throw new RunnerError("auth", message)
        throw classifyError(Object.assign(new Error(message), { name }))
      }
      if (info.structured === undefined || info.structured === null) {
        throw new RunnerError("invalid_output", "Model did not produce structured output")
      }
      return { output: info.structured, ...(await this.usage(id, directory)) }
    } catch (e) {
      const err = withUsage(classifyError(e), e)
      throw withUsage(err, await this.listedUsage(id, directory))
    } finally {
      signal.removeEventListener("abort", onAbort)
      await this.client.session.delete({ path: { id }, query: { directory } }).catch(() => {})
      inFlight.delete(id)
    }
  }
}
