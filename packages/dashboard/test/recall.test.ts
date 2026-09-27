import { describe, expect, test } from "bun:test"
import { hasTruncatedPart, mergeRecall, nextRecallRequest, parseRecallCursor, recallRequestFor, unwrapRecall, withVia } from "../src/recall"
import type { RecallMessage, RecallOk, RecallPart } from "../src/types"

function msg(seq: number): RecallMessage {
  return { id: `m${seq}`, seq, role: seq % 2 ? "user" : "assistant", agent: null, createdAt: seq, status: "present", parts: [] }
}

function part(id: string, over: Partial<RecallPart> = {}): RecallPart {
  return { id, type: "text", tool: null, text: "x", redactions: 0, omitted: 0, forgotten: false, ...over }
}

function range(from: number, to: number): RecallMessage[] {
  const out: RecallMessage[] = []
  for (let s = from; s <= to; s++) out.push(msg(s))
  return out
}

function okResult(raw: unknown): RecallOk {
  const r = unwrapRecall(raw)
  if (!r.ok) throw new Error(`expected ok recall, got ${r.error}`)
  return r
}

describe("unwrapRecall", () => {
  test("keeps the untruncated shape as before", () => {
    const r = okResult({ ok: true, guarantee: "g", sessionId: "s", fromSeq: 1, toSeq: 2, messages: range(1, 2), cited: [[1, 2]] })
    expect(r.truncated).toBeUndefined()
    expect(r.nextCursor).toBeUndefined()
    expect(r.messages.length).toBe(2)
    expect(r.cited).toEqual([[1, 2]])
  })

  test("parses truncated with the new cursor shape", () => {
    const r = okResult({
      ok: true,
      guarantee: "g (truncated)",
      sessionId: "s",
      fromSeq: 1,
      toSeq: 40,
      messages: range(1, 40),
      truncated: true,
      nextCursor: { fromSeq: 41, toSeq: 55, context: 0, observationId: "obs1" },
    })
    expect(r.truncated).toBe(true)
    expect(r.nextCursor).toEqual({ fromSeq: 41, toSeq: 55, context: 0, observationId: "obs1" })
  })

  test("parses the older { sessionId, fromSeq } cursor", () => {
    const r = okResult({ ok: true, guarantee: "g", sessionId: "s", fromSeq: 1, toSeq: 40, messages: range(1, 40), truncated: true, nextCursor: { sessionId: "s", fromSeq: 41 } })
    expect(r.nextCursor).toEqual({ sessionId: "s", fromSeq: 41 })
  })

  test("truncated without a cursor stays truncated; a cursor implies truncated", () => {
    expect(okResult({ ok: true, guarantee: "g", sessionId: "s", fromSeq: 1, toSeq: 1, messages: [msg(1)], truncated: true }).truncated).toBe(true)
    const implied = okResult({ ok: true, guarantee: "g", sessionId: "s", fromSeq: 1, toSeq: 1, messages: [msg(1)], nextCursor: { fromSeq: 2 } })
    expect(implied.truncated).toBe(true)
  })

  test("ignores malformed cursors", () => {
    expect(parseRecallCursor({ fromSeq: "41" })).toBeUndefined()
    expect(parseRecallCursor({ sessionId: "s" })).toBeUndefined()
    expect(parseRecallCursor(null)).toBeUndefined()
    expect(parseRecallCursor({ fromSeq: 3, toSeq: "x", observationId: 5 })).toEqual({ fromSeq: 3 })
  })

  test("keeps per-part truncated flags, and a cut part marks the page truncated", () => {
    const cut = { ...msg(1), parts: [part("p1", { text: "abc\n[… 90000 chars omitted …]", truncated: true }), part("p2")] }
    const r = okResult({ ok: true, guarantee: "g", sessionId: "s", fromSeq: 1, toSeq: 1, messages: [cut] })
    expect(r.messages[0].parts.map((p) => p.truncated)).toEqual([true, undefined])
    expect(r.truncated).toBe(true)
    expect(r.nextCursor).toBeUndefined()
  })

  test("unwraps a nested data envelope and failures", () => {
    expect(unwrapRecall({ data: { ok: true, guarantee: "g", sessionId: "s", fromSeq: 1, toSeq: 1, messages: [] } }).ok).toBe(true)
    expect(unwrapRecall({ ok: false, error: "nope" })).toEqual({ ok: false, error: "nope" })
    expect(unwrapRecall(null)).toEqual({ ok: false, error: "empty recall" })
  })
})

describe("nextRecallRequest", () => {
  const base = { ok: true as const, guarantee: "g", sessionId: "sess", fromSeq: 1, toSeq: 40, messages: range(1, 40), truncated: true }

  test("observation cursor fetches the rest of the observation's source", () => {
    expect(nextRecallRequest({ ...base, nextCursor: { fromSeq: 41, toSeq: 55, context: 0, observationId: "obs1" } })).toEqual({
      observation: "obs1",
      from: 41,
      to: 55,
      context: 0,
    })
  })

  test("observation cursor keeps its original padding and observation id", () => {
    const cursor = { sessionId: "sess_src", fromSeq: 41, toSeq: 90, context: 3, observationId: "obs_orig" }
    const req = nextRecallRequest({ ...base, nextCursor: { ...cursor }, via: { session: "sess_view" } })
    expect(req).toEqual({ observation: "obs_orig", from: 41, to: 90, context: 3, session: "sess_view" })
  })

  test("new cursor without observationId falls back to a session range on the result's session, context echoed", () => {
    expect(nextRecallRequest({ ...base, nextCursor: { fromSeq: 41, toSeq: 70, context: 2 } })).toEqual({ session: "sess", from: 41, to: 70, context: 2 })
    expect(nextRecallRequest({ ...base, nextCursor: { sessionId: "sess", fromSeq: 41, toSeq: 70, context: 0 } })).toEqual({ session: "sess", from: 41, to: 70, context: 0 })
  })

  test("old cursor uses its session and the end of the cited range", () => {
    expect(nextRecallRequest({ ...base, cited: [[30, 60]], nextCursor: { sessionId: "other", fromSeq: 41 } })).toEqual({
      session: "other",
      from: 41,
      to: 60,
      context: 0,
    })
  })

  test("old cursor without cited ranges asks for one page", () => {
    expect(nextRecallRequest({ ...base, nextCursor: { sessionId: "sess", fromSeq: 41 } })).toEqual({ session: "sess", from: 41, to: 81, context: 0 })
  })

  test("no cursor, no request", () => {
    expect(nextRecallRequest(base)).toBeUndefined()
  })
})

describe("mergeRecall", () => {
  const first: RecallOk = {
    ok: true,
    guarantee: "g (truncated)",
    sessionId: "s",
    fromSeq: 1,
    toSeq: 40,
    messages: range(1, 40),
    truncated: true,
    nextCursor: { fromSeq: 41, toSeq: 55, context: 0, observationId: "o" },
  }

  test("appends the next page, dropping overlap, and adopts its cursor", () => {
    const next: RecallOk = { ok: true, guarantee: "g", sessionId: "s", fromSeq: 40, toSeq: 55, messages: range(40, 55), truncated: false }
    const { result, added } = mergeRecall(first, next)
    expect(added).toBe(15)
    expect(result.messages.map((m) => m.seq)).toEqual(range(1, 55).map((m) => m.seq))
    expect(result.toSeq).toBe(55)
    expect(result.truncated).toBe(false)
    expect(result.nextCursor).toBeUndefined()
  })

  test("a page that adds nothing clears the cursor so the view cannot loop", () => {
    const same: RecallOk = { ...first }
    const { result, added } = mergeRecall(first, same)
    expect(added).toBe(0)
    expect(result.messages.length).toBe(40)
    expect(result.truncated).toBe(true)
    expect(result.nextCursor).toBeUndefined()
    expect(nextRecallRequest(result)).toBeUndefined()
  })

  test("keeps per-part truncated flags and page-1 truncation after the last page", () => {
    const cut: RecallMessage = { ...msg(1), parts: [part("p1", { truncated: true })] }
    const page1: RecallOk = { ...first, messages: [cut, ...range(2, 40)] }
    const last: RecallOk = { ok: true, guarantee: "g", sessionId: "s", fromSeq: 41, toSeq: 55, messages: range(41, 55), truncated: false }
    const { result } = mergeRecall(page1, last)
    expect(result.messages[0].parts[0].truncated).toBe(true)
    expect(hasTruncatedPart(result.messages)).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.nextCursor).toBeUndefined()
  })

  test("an overlapping message keeps the copy (and flags) already shown", () => {
    const cut: RecallMessage = { ...msg(40), parts: [part("p40", { truncated: true })] }
    const page1: RecallOk = { ...first, messages: [...range(1, 39), cut] }
    const next: RecallOk = { ok: true, guarantee: "g", sessionId: "s", fromSeq: 40, toSeq: 41, messages: [msg(40), msg(41)] }
    const { result } = mergeRecall(page1, next)
    expect(result.messages.find((m) => m.seq === 40)?.parts[0].truncated).toBe(true)
  })

  test("keeps the access hints for the following page", () => {
    const withHints: RecallOk = { ...first, via: { session: "sess_a", project: "proj_a" } }
    const next: RecallOk = { ...first, fromSeq: 41, toSeq: 80, messages: range(41, 80), nextCursor: { fromSeq: 81, toSeq: 90, context: 0, observationId: "o" } }
    const { result } = mergeRecall(withHints, next)
    expect(result.via).toEqual({ session: "sess_a", project: "proj_a" })
    expect(nextRecallRequest(result)).toEqual({ observation: "o", from: 81, to: 90, context: 0, session: "sess_a", project: "proj_a" })
  })
})

describe("recall access hints", () => {
  const row = { id: "obs1", session_id: "sess_b", project_id: "proj_b" }

  test("an observation recall is read as the row's own session and project", () => {
    expect(recallRequestFor(row)).toEqual({ observation: "obs1", context: 1, session: "sess_b", project: "proj_b" })
    expect(recallRequestFor(row, "sess_embed")).toEqual({ observation: "obs1", context: 1, session: "sess_b", project: "proj_b" })
  })

  test("rows without a session fall back to the caller's session", () => {
    expect(recallRequestFor({ id: "u1", session_id: null, project_id: null }, "sess_embed")).toEqual({ observation: "u1", context: 1, session: "sess_embed" })
    expect(recallRequestFor({ id: "u1", session_id: null, project_id: "proj_c" })).toEqual({ observation: "u1", context: 1, project: "proj_c" })
  })

  test("withVia records the hints on successful pages only", () => {
    const ok = unwrapRecall({ ok: true, guarantee: "g", sessionId: "s", fromSeq: 1, toSeq: 1, messages: [msg(1)] })
    const tagged = withVia(ok, recallRequestFor(row))
    expect(tagged.ok && tagged.via).toEqual({ session: "sess_b", project: "proj_b" })
    expect(withVia({ ok: false, error: "nope" }, recallRequestFor(row))).toEqual({ ok: false, error: "nope" })
    const bare = withVia(ok, { observation: "obs1" })
    expect(bare.ok && bare.via).toBeUndefined()
  })

  test("a session-range cursor reads its own session and keeps the project hint", () => {
    const r: RecallOk = {
      ok: true,
      guarantee: "g",
      sessionId: "sess_src",
      fromSeq: 1,
      toSeq: 40,
      messages: range(1, 40),
      nextCursor: { sessionId: "sess_src", fromSeq: 41, toSeq: 60 },
      via: { session: "sess_embed", project: "proj_b" },
    }
    expect(nextRecallRequest(r)).toEqual({ session: "sess_src", from: 41, to: 60, context: 0, project: "proj_b" })
  })
})
