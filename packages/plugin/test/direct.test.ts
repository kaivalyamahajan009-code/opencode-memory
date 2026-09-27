import "./hermetic"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { defaultConfig, RunnerError, usageOfError, type MemoryConfig } from "@opencode-memory/core"
import { DirectRunner, slimError } from "../src/runners/direct"
import { rmDir, tempDir } from "./helpers"

describe("direct runner", () => {
  let server: Server
  let port = 0
  let reply: { status: number; body: string } = { status: 200, body: "{}" }
  let requestCount = 0
  let capturedHeaders: Record<string, string | string[] | undefined> = {}

  beforeAll(async () => {
    server = createServer((req, res) => {
      requestCount++
      capturedHeaders = req.headers
      req.resume()
      req.on("end", () => {
        res.writeHead(reply.status, { "content-type": "application/json" })
        res.end(reply.body)
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    const addr = server.address()
    port = addr && typeof addr === "object" ? addr.port : 0
    process.env.OM_DIRECT_TEST_KEY = "test-key"
  })

  afterAll(async () => {
    delete process.env.OM_DIRECT_TEST_KEY
    await new Promise<void>((r) => server.close(() => r()))
    rmDir(dataDir)
  })

  const dataDir = tempDir()
  const config = (headers?: Record<string, string>): MemoryConfig => {
    const base = defaultConfig(dataDir)
    return {
      ...base,
      runner: {
        ...base.runner,
        kind: "direct",
        direct: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          model: "m-test",
          apiKeyEnv: "OM_DIRECT_TEST_KEY",
          headers,
          inputCostPerMTok: 2,
          outputCostPerMTok: 10,
        },
      },
    }
  }

  const req = { purpose: "observe" as const, agent: "om-observer" as const, system: "s", prompt: "p", schema: {} }

  test("non-JSON model output throws invalid_output carrying what the call cost", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ model: "m-served", choices: [{ message: { content: "not json at all" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }),
    }
    const runner = new DirectRunner(config)
    const err = await runner.run(req, new AbortController().signal).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(RunnerError)
    expect((err as RunnerError).cls).toBe("invalid_output")
    expect(usageOfError(err)).toEqual({ cost: 7, inputTokens: 1_000_000, outputTokens: 500_000, model: "m-served" })
  })

  test("JSON output returns the parsed object and usage", async () => {
    reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"observations":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) }
    const r = await new DirectRunner(config).run(req, new AbortController().signal)
    expect(r.output).toEqual({ observations: [] })
    expect(r.inputTokens).toBe(10)
    expect(r.model).toBe("m-test")
  })

  test("sends custom headers while generated content type and authorization win case-insensitively", async () => {
    reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "{}" } }] }) }
    await new DirectRunner(() =>
      config({
        "X-Tenant": "memory-team",
        "Content-Type": "text/plain",
        Authorization: "Custom secret that must not win",
      }),
    ).run(req, new AbortController().signal)
    expect(capturedHeaders["x-tenant"]).toBe("memory-team")
    expect(capturedHeaders["content-type"]).toBe("application/json")
    expect(capturedHeaders.authorization).toBe("Bearer test-key")
  })

  test("rejects unsafe custom headers before making a request and does not expose their values", async () => {
    for (const headers of [
      { "Bad Header": "sensitive-name-value" },
      { "x-injected": "safe\r\nx-evil: sensitive-line-value" },
      JSON.parse('{"__proto__":"sensitive-prototype-value"}') as Record<string, string>,
    ]) {
      const before = requestCount
      const err = await new DirectRunner(() => config(headers)).run(req, new AbortController().signal).catch((e: unknown) => e)
      expect(err).toMatchObject({ cls: "auth", message: "direct runner headers are invalid" })
      expect(String((err as Error).message)).not.toContain("sensitive")
      expect(requestCount).toBe(before)
    }
  })

  test("slimError redacts before truncating, so a secret at the cut is never half-kept", () => {
    const secret = `sk-${"A".repeat(30)}`
    const text = `${"x ".repeat(115)}${secret} trailing`
    const out = slimError(text)
    expect(out.length).toBeLessThanOrEqual(240)
    expect(out).not.toContain("sk-AAAA")
    expect(slimError("short message")).toBe("short message")
  })

  test("an error body with a key is redacted in the thrown message", async () => {
    reply = { status: 401, body: JSON.stringify({ error: `invalid key sk-${"B".repeat(40)}` }) }
    const err = await new DirectRunner(config).run(req, new AbortController().signal).catch((e: unknown) => e)
    expect((err as RunnerError).cls).toBe("auth")
    expect(String((err as Error).message)).not.toContain("BBBBBBBB")
  })
})
