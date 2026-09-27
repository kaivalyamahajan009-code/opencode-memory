import { testHome } from "./hermetic"
import { afterEach, describe, expect, test } from "bun:test"
import { configPath, defaultDataDir, RunnerError, usageOfError, type ModelRunner } from "@opencode-memory/core"
import plugin from "../src/index"
import { OpenCodeSessionRunner, usageFromMessages } from "../src/runners/opencode-session"
import { getMemoryService, liveRunner } from "../src/service"
import { fakeClient, fakeInput, fakeObserverOutput, freePort, rmDir, tempDir } from "./helpers"

test("tests read memory config and data from a throwaway home, never the developer's", () => {
  expect(configPath().startsWith(testHome!)).toBe(true)
  expect(defaultDataDir().startsWith(testHome!)).toBe(true)
})

describe("runners", () => {
  test("liveRunner follows the live runner kind", async () => {
    let kind: "fake" | "direct" = "fake"
    const made: string[] = []
    const r = liveRunner(
      () => kind,
      (k): ModelRunner => {
        made.push(k)
        return { id: k, run: async () => ({ output: k, inputTokens: 0, outputTokens: 0, cost: 0, model: k }) }
      },
    )
    expect(r.id).toBe("fake")
    kind = "direct"
    expect(r.id).toBe("direct")
    expect((await r.run({} as any, new AbortController().signal)).output).toBe("direct")
    kind = "fake"
    expect(r.id).toBe("fake")
    expect(made).toEqual(["fake", "direct"])
  })

  test("opencode-session runner prompts the om agent without body.system and survives a rejecting abort", async () => {
    const base = fakeClient()
    const prompts: any[] = []
    const engine = { markInternal() {} } as any
    const req = { purpose: "observe" as const, agent: "om-observer" as const, system: "SYS", prompt: "P", schema: {} }
    const client = {
      ...base,
      session: {
        ...base.session,
        async prompt(opts: any) {
          prompts.push(opts)
          return { data: { info: { structured: { observations: [] } } } }
        },
        async abort() {
          throw new Error("abort failed")
        },
      },
    }
    await new OpenCodeSessionRunner(client, engine, "/tmp").run(req, new AbortController().signal)
    expect(prompts[0].body.agent).toBe("om-observer")
    expect(prompts[0].body.system).toBeUndefined()

    const slow = {
      ...client,
      session: {
        ...client.session,
        prompt: (opts: any) =>
          new Promise((_, reject) =>
            opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
          ),
      },
    }
    const ac = new AbortController()
    const run = new OpenCodeSessionRunner(slow as any, engine, "/tmp").run(req, ac.signal)
    await new Promise((r) => setTimeout(r, 5))
    ac.abort()
    await expect(run).rejects.toMatchObject({ cls: "aborted" })
    await new Promise((r) => setTimeout(r, 10))
  })

  test("opencode-session invalid_output and other failures carry what the child session cost", async () => {
    const base = fakeClient([
      { info: { role: "assistant", cost: 0.25, providerID: "p", modelID: "m", tokens: { input: 100, output: 20 } } },
    ])
    const engine = { markInternal() {} } as any
    const req = { purpose: "observe" as const, agent: "om-observer" as const, system: "SYS", prompt: "P", schema: {} }
    const run = (prompt: () => Promise<unknown>, messages?: () => Promise<unknown>) =>
      new OpenCodeSessionRunner({ ...base, session: { ...base.session, prompt, ...(messages ? { messages } : {}) } } as any, engine, "/tmp")
        .run(req, new AbortController().signal)
        .then(
          () => undefined,
          (e: unknown) => e as RunnerError,
        )
    const paid = { cost: 0.25, inputTokens: 100, outputTokens: 20, model: "p/m" }

    const structured = await run(async () => ({ data: { info: { error: { name: "StructuredOutputError", data: { message: "bad schema" } } } } }))
    expect(structured?.cls).toBe("invalid_output")
    expect(usageOfError(structured)).toEqual(paid)

    const missing = await run(async () => ({ data: { info: {} } }))
    expect(missing?.cls).toBe("invalid_output")
    expect(usageOfError(missing)).toEqual(paid)

    const provider = await run(async () => ({ data: { info: { error: { name: "APIError", data: { message: "upstream 503" } } } } }))
    expect(provider?.cls).toBe("transient")
    expect(usageOfError(provider)).toEqual(paid)

    const unlisted = await run(
      async () => {
        throw Object.assign(new Error("socket hang up"), { cost: 0.5, inputTokens: 7, outputTokens: 3, model: "x/y" })
      },
      async () => {
        throw new Error("messages unavailable")
      },
    )
    expect(unlisted).toBeInstanceOf(RunnerError)
    expect(usageOfError(unlisted)).toEqual({ cost: 0.5, inputTokens: 7, outputTokens: 3, model: "x/y" })
  })

  test("session usage sums every assistant message including cache and reasoning tokens", () => {
    const usage = usageFromMessages([
      { info: { role: "user" } },
      { info: { role: "assistant", cost: 0.01, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 3 } } } },
      { info: { role: "assistant", cost: 0.02, providerID: "p", modelID: "m", tokens: { input: 1, output: 1 } } },
    ])
    expect(usage.inputTokens).toBe(114)
    expect(usage.outputTokens).toBe(8)
    expect(usage.cost).toBeCloseTo(0.03)
    expect(usage.model).toBe("p/m")
  })
})

describe("concurrent acquireService", () => {
  const dirs: string[] = []
  afterEach(async () => {
    const svc = getMemoryService()
    if (svc) {
      while (svc.refs > 0) {
        /* refs released via dispose */
        break
      }
    }
    while (dirs.length) rmDir(dirs.pop()!)
  })

  test("concurrent plugin.server shares one engine", async () => {
    const dirA = tempDir()
    const dirB = tempDir()
    dirs.push(dirA, dirB)
    const port = await freePort()
    const [hooksA, hooksB] = await Promise.all([
      plugin.server(fakeInput(dirA, fakeClient()), { dataDir: dirA, port, runner: "fake", fakeOutputs: [fakeObserverOutput] }),
      plugin.server(fakeInput(dirB, fakeClient()), { dataDir: dirA, port, runner: "fake", fakeOutputs: [fakeObserverOutput] }),
    ])
    const svc = getMemoryService()!
    expect(svc.refs).toBe(2)
    expect(svc.engine.instanceCount).toBe(2)
    const engine = svc.engine
    await hooksA.dispose?.()
    expect(getMemoryService()?.engine).toBe(engine)
    expect(getMemoryService()?.refs).toBe(1)
    await hooksB.dispose?.()
    expect(getMemoryService()).toBeUndefined()
  })
})
