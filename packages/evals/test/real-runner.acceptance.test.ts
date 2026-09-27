import "./hermetic"
import { describe, expect, test } from "bun:test"
import { parseRealConfig, runRealEval } from "../real/run"

describe("acceptance: opt-in real evaluator safety", () => {
  test("defaults to skipped without making any network request", async () => {
    let fetched = false
    const summary = await runRealEval({
      args: [],
      env: {},
      fetchImpl: (async () => {
        fetched = true
        throw new Error("must not fetch")
      }) as unknown as typeof fetch,
    })
    expect(fetched).toBe(false)
    expect(summary).toMatchObject({ status: "skipped", live: false })
    expect(summary.reason).toContain("--confirm-live")
  })

  test("dry-run validates bounded configuration and still makes no live call", async () => {
    let fetched = false
    const summary = await runRealEval({
      args: ["--dry-run", "--sessions=2", "--max-cost-usd=0.1", "--timeout-ms=5000", "--model=fake/model"],
      env: {},
      fetchImpl: (async () => {
        fetched = true
        throw new Error("must not fetch")
      }) as unknown as typeof fetch,
    })
    expect(fetched).toBe(false)
    expect(summary).toMatchObject({
      status: "dry-run",
      live: false,
      limits: { maxSessions: 2, maxCostUsd: 0.1, timeoutMs: 5_000 },
    })
    expect(parseRealConfig(["--validate"], {}).explicitlyDry).toBe(true)
    expect((await runRealEval({ args: ["--dry-run", "--sessions=99"], env: {} })).status).toBe("failed")
  })

  test("confirmed execution is bounded, validates structured output, accounts usage, and deletes every session", async () => {
    const deleted: string[] = []
    let created = 0
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      const method = init?.method ?? "GET"
      if (method === "POST" && url.pathname === "/session") {
        created++
        return Response.json({ id: `real-${created}` })
      }
      if (method === "POST" && /\/session\/real-\d+\/message$/.test(url.pathname)) {
        const body = JSON.parse(String(init?.body))
        const sentinel = String(body.parts[0].text).match(/deterministic-eval-\d+/)?.[0]
        return Response.json({
          info: {
            structured: {
              observations: [
                {
                  kind: "preference",
                  content: `The user prefers ${sentinel}`,
                  confidence: 0.9,
                  evidenceType: "explicit",
                  priority: "medium",
                  sources: { start: "m1", end: "m1" },
                  scopeHint: "user",
                },
              ],
            },
          },
        })
      }
      if (method === "GET" && /\/session\/real-\d+\/message$/.test(url.pathname)) {
        return Response.json([
          {
            info: {
              role: "assistant",
              cost: 0.01,
              tokens: { input: 20, output: 10, reasoning: 2, cache: { read: 3, write: 4 } },
            },
          },
        ])
      }
      if (method === "DELETE" && /\/session\/real-\d+$/.test(url.pathname)) {
        deleted.push(url.pathname.split("/").at(-1)!)
        return Response.json(true)
      }
      return new Response("not found", { status: 404 })
    }
    const summary = await runRealEval({
      args: ["--confirm-live", "--server=http://127.0.0.1:4096", "--sessions=2", "--max-cost-usd=0.05"],
      env: {},
      fetchImpl: fakeFetch as typeof fetch,
    })
    expect(summary).toMatchObject({
      status: "passed",
      live: true,
      sessions: { attempted: 2, completed: 2, cleaned: 2 },
      usage: { inputTokens: 54, outputTokens: 24, costUsd: 0.02 },
    })
    expect(summary.checks.every((check) => check.passed)).toBe(true)
    expect(deleted).toEqual(["real-1", "real-2"])
  })
})
