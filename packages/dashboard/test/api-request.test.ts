import { describe, expect, test } from "bun:test"
import { ApiError, requestJson } from "../src/api-unwrap"

type Call = { input: string; init?: RequestInit }

function fake(res: Response | Error) {
  const calls: Call[] = []
  const impl = async (input: string, init?: RequestInit) => {
    calls.push({ input, init })
    if (res instanceof Error) throw res
    return res
  }
  return { impl, calls }
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error("expected the request to fail")
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("requestJson", () => {
  test("network failure maps to status 0", async () => {
    const f = fake(new TypeError("fetch failed"))
    const e = await failure(requestJson(f.impl, "/api/status", "t"))
    expect(e.status).toBe(0)
    expect(e.message).toBe("Memory API unreachable")
  })

  test("401 maps to Unauthorized regardless of body", async () => {
    const e = await failure(requestJson(fake(json({ ok: false, error: "unauthorized" }, 401)).impl, "/api/status", "bad"))
    expect(e.status).toBe(401)
    expect(e.message).toBe("Unauthorized")
  })

  test("404 envelope keeps the server's message and status", async () => {
    const e = await failure(requestJson(fake(json({ ok: false, error: "not found" }, 404)).impl, "/api/observations/x", "t"))
    expect(e.status).toBe(404)
    expect(e.message).toBe("not found")
  })

  test("non-JSON error body maps to HTTP status", async () => {
    const e = await failure(requestJson(fake(new Response("<html>oops</html>", { status: 502 })).impl, "/api/status", "t"))
    expect(e.status).toBe(502)
    expect(e.message).toBe("HTTP 502")
  })

  test("non-JSON 200 body is an error, not data", async () => {
    const e = await failure(requestJson(fake(new Response("<!doctype html>", { status: 200 })).impl, "/api/status", "t"))
    expect(e.status).toBe(200)
    expect(e.message).toBe("Invalid response from memory API")
  })

  test("nested done:false is surfaced as 409", async () => {
    const e = await failure(requestJson(fake(json({ ok: true, data: { done: false } })).impl, "/api/review/r1", "t", { method: "POST", body: "{}" }))
    expect(e.status).toBe(409)
  })

  test("returns data and sends the token only in the X-OM-Token header", async () => {
    const f = fake(json({ ok: true, data: { n: 1 } }))
    expect(await requestJson<{ n: number }>(f.impl, "/api/status?session=s", "secret", { method: "POST", body: "{}" })).toEqual({ n: 1 })
    const headers = new Headers(f.calls[0].init?.headers)
    expect(headers.get("x-om-token")).toBe("secret")
    expect(headers.get("content-type")).toBe("application/json")
    expect(f.calls[0].input).not.toContain("secret")
  })
})
