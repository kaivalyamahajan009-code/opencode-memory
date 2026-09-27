import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { fetchRecall, forgetCandidates, forgetObservations } from "../src/api"
import { forgetBody, forgetRequest } from "../src/forget-select"
import { nextRecallRequest, recallRequestFor } from "../src/recall"

type Call = { url: string; body?: unknown; token: string | null }

const calls: Call[] = []
let reply: unknown = { ok: true, data: {} }
const saved = { fetch: globalThis.fetch, document: (globalThis as { document?: unknown }).document }

beforeAll(() => {
  ;(globalThis as { document?: unknown }).document = {
    querySelector: (sel: string) => (sel.includes("om-token") ? { getAttribute: () => "tok" } : null),
  }
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, token: headers.get("x-om-token") })
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = saved.fetch
  ;(globalThis as { document?: unknown }).document = saved.document
})

beforeEach(() => {
  calls.length = 0
})

describe("forget on the wire", () => {
  test("POST /api/forget carries no session or project (global user forget)", async () => {
    reply = { ok: true, data: { observationIds: ["obs_1"], partsPurged: 0, topicsTouched: [], snapshotsPurged: 0, skipped: [], scrubPending: true } }
    await forgetObservations(forgetBody(forgetRequest("obs_1", ["obs_2"])))
    expect(calls[0].url).toBe("/api/forget")
    expect(calls[0].body).toEqual({ ids: ["obs_1", "obs_2"], confirm: true, reason: "dashboard forget", purgeSources: "none" })
    expect(calls[0].token).toBe("tok")
  })

  test("POST /api/forget/candidates carries only the text", async () => {
    reply = { ok: true, data: [] }
    await forgetCandidates("dark mode")
    expect(calls[0].url).toBe("/api/forget/candidates")
    expect(calls[0].body).toEqual({ text: "dark mode" })
  })
})

describe("recall on the wire", () => {
  const page = (cursor?: unknown) => ({
    ok: true,
    data: { ok: true, guarantee: "g", sessionId: "sess_b", fromSeq: 1, toSeq: 1, messages: [], truncated: !!cursor, nextCursor: cursor },
  })

  test("GET /api/recall names the row's session and project, and Load more keeps them", async () => {
    reply = page({ sessionId: "sess_b", fromSeq: 41, toSeq: 60, context: 0, observationId: "obs_1" })
    const first = await fetchRecall(recallRequestFor({ id: "obs_1", session_id: "sess_b", project_id: "proj_b" }, "sess_a"))
    const u = new URL(calls[0].url, "http://x")
    expect(u.pathname).toBe("/api/recall")
    expect(Object.fromEntries(u.searchParams)).toEqual({ observation: "obs_1", context: "1", session: "sess_b", project: "proj_b" })
    if (!first.ok) throw new Error(first.error)
    const req = nextRecallRequest(first)
    expect(req).toEqual({ observation: "obs_1", from: 41, to: 60, context: 0, session: "sess_b", project: "proj_b" })
    reply = page()
    await fetchRecall(req!)
    expect(Object.fromEntries(new URL(calls[1].url, "http://x").searchParams)).toEqual({
      observation: "obs_1",
      from: "41",
      to: "60",
      context: "0",
      session: "sess_b",
      project: "proj_b",
    })
  })
})
