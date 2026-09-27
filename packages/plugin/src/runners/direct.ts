import { classifyError, openAICompatibleHeaders, redact, RunnerError, type MemoryConfig, type ModelRunner, type RunRequest, type RunResult } from "@opencode-memory/core"

function allowedBaseURL(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol === "https:") return true
  if (u.protocol === "http:") {
    const h = u.hostname.replace(/^\[|\]$/g, "")
    return h === "127.0.0.1" || h === "localhost" || h === "::1"
  }
  return false
}

/** Redact first: truncating first can cut a secret below the length its pattern needs. */
export function slimError(text: string): string {
  return redact(text).text.slice(0, 240)
}

export class DirectRunner implements ModelRunner {
  readonly id = "direct"

  constructor(
    private readonly getConfig: () => MemoryConfig,
    private readonly which: "runner" | "reflectorRunner" = "runner",
  ) {}

  async run(req: RunRequest, signal: AbortSignal): Promise<RunResult> {
    const config = this.getConfig()
    const spec = this.which === "reflectorRunner" ? (config.reflectorRunner ?? config.runner) : config.runner
    const direct = spec.direct
    if (!direct) throw new RunnerError("auth", "direct runner is not configured")
    if (!allowedBaseURL(direct.baseURL)) throw new RunnerError("auth", "direct runner baseURL must be https or loopback http")
    const key = process.env[direct.apiKeyEnv]
    if (!key) throw new RunnerError("auth", `missing API key env ${direct.apiKeyEnv}`)
    const url = `${direct.baseURL.replace(/\/$/, "")}/chat/completions`
    const name = req.agent.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "memory"
    let headers: Headers
    try {
      headers = openAICompatibleHeaders(direct.headers, key)
    } catch {
      throw new RunnerError("auth", "direct runner headers are invalid")
    }
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: direct.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name, schema: req.schema, strict: false },
          },
        }),
        signal,
      })
    } catch (e) {
      throw classifyError(e)
    }
    if (res.status === 401 || res.status === 403) throw new RunnerError("auth", slimError(await res.text().catch(() => res.statusText)))
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"))
      throw new RunnerError("rate_limit", "rate limited", Number.isFinite(ra) ? ra * 1000 : undefined)
    }
    if (!res.ok) {
      const body = slimError(await res.text().catch(() => res.statusText))
      throw classifyError(Object.assign(new Error(body), { status: res.status }))
    }
    const json = (await res.json()) as any
    const choice = json.choices?.[0]
    const content = choice?.message?.content
    const text = Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("") : String(content ?? "")
    const usage = json.usage ?? {}
    const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0)
    const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
    const inCost = direct.inputCostPerMTok ?? 0
    const outCost = direct.outputCostPerMTok ?? 0
    const cost = (inputTokens / 1e6) * inCost + (outputTokens / 1e6) * outCost
    const model = String(json.model ?? direct.model)
    let output: unknown
    try {
      output = JSON.parse(text)
    } catch {
      throw Object.assign(new RunnerError("invalid_output", "direct runner did not return JSON"), { cost, inputTokens, outputTokens, model })
    }
    return { output, inputTokens, outputTokens, cost, model }
  }
}
