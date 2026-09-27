import { describe, expect, test } from "bun:test"
import { ApiError } from "../src/api-unwrap"
import { commandOutcome, flushErrorText, flushStartMessage, parseCommandResult, parseCommandStatus, parseFlushResponse, pollCommand } from "../src/commands"

describe("parseFlushResponse", () => {
  test("a flush run by this server's own window is done", () => {
    const s = parseFlushResponse({ routed: false, result: { chunks: ["c1", "c2"], outcomes: [], waited: false } })
    expect(s).toEqual({ kind: "done", chunks: 2 })
    expect(flushStartMessage(s)).toBe("Flushed: 2 chunks sent to the observer")
    expect(flushStartMessage(parseFlushResponse({ routed: false, result: { chunks: [] } }))).toBe("Flushed: nothing new to flush")
  })

  test("a flush routed to another window is queued with its command id", () => {
    const s = parseFlushResponse({ routed: true, commandId: 7, state: "pending" })
    expect(s).toEqual({ kind: "queued", commandId: 7 })
    expect(flushStartMessage(s)).toBe("Queued for the OpenCode window that owns this project")
  })

  test("a local background run is running", () => {
    expect(parseFlushResponse({ routed: false, commandId: 3, state: "running" })).toEqual({ kind: "running", commandId: 3 })
  })

  test("older or unexpected shapes are treated as done", () => {
    expect(parseFlushResponse({ done: true })).toEqual({ kind: "done", chunks: undefined })
    expect(flushStartMessage(parseFlushResponse(null))).toBe("Flush requested")
  })

  test("409 (no live window owns the project) gets its own explanation", () => {
    expect(flushErrorText(new ApiError("No OpenCode window owns this project", 409))).toContain("no open OpenCode window has this project")
    expect(flushErrorText(new ApiError("not found", 404))).toBe("Flush failed: not found")
  })
})

describe("parseCommandStatus", () => {
  test("result arrives as JSON text and is parsed", () => {
    const s = parseCommandStatus({ id: 7, kind: "flush", state: "done", result: '{"chunks":["c1"],"outcomes":[],"waited":false}', attempts: 1 })
    expect(s?.state).toBe("done")
    expect(s?.result).toEqual({ chunks: ["c1"], outcomes: [], waited: false })
    expect(commandOutcome(s)).toEqual({ tone: "ok", text: "Flush finished: 1 chunk sent to the observer" })
  })

  test("failed commands surface the stored error", () => {
    const s = parseCommandStatus({ id: 7, state: "failed", result: '{"error":"command lease expired (instance stopped while running it)"}' })
    expect(s?.error).toBe("command lease expired (instance stopped while running it)")
    expect(commandOutcome(s)).toEqual({ tone: "error", text: "Flush failed: command lease expired (instance stopped while running it)" })
  })

  test("invalid JSON text, null results and unknown states are tolerated", () => {
    expect(parseCommandResult("not json")).toBe("not json")
    expect(parseCommandResult(null)).toBeUndefined()
    expect(parseCommandResult({ a: 1 })).toEqual({ a: 1 })
    expect(parseCommandStatus({ id: 1, state: "failed", result: "boom" })?.error).toBe("boom")
    expect(parseCommandStatus({ id: 1, state: "weird", result: null })?.state).toBe("unknown")
    expect(parseCommandStatus("nope")).toBeUndefined()
  })

  test("expired and still-pending outcomes read clearly", () => {
    expect(commandOutcome(parseCommandStatus({ id: 1, state: "expired", result: null })).text).toContain("no OpenCode window")
    expect(commandOutcome(parseCommandStatus({ id: 1, state: "pending", result: null })).text).toContain("still queued")
    expect(commandOutcome(undefined).tone).toBe("warn")
  })
})

describe("pollCommand", () => {
  const instant = async () => {}

  test("polls through pending and running until done", async () => {
    const states = [
      { id: 7, state: "pending", result: null },
      { id: 7, state: "running", result: null },
      { id: 7, state: "done", result: '{"chunks":["c1"]}' },
    ]
    const seen: number[] = []
    const final = await pollCommand(7, {
      fetch: async (id) => {
        seen.push(id)
        return states.shift()
      },
      signal: new AbortController().signal,
      sleep: instant,
    })
    expect(seen).toEqual([7, 7, 7])
    expect(final?.state).toBe("done")
  })

  test("abort stops polling and reports nothing", async () => {
    const ctl = new AbortController()
    let calls = 0
    const final = await pollCommand(7, {
      fetch: async () => {
        calls++
        if (calls === 2) ctl.abort()
        return { id: 7, state: "pending" }
      },
      signal: ctl.signal,
      sleep: instant,
    })
    expect(final).toBeUndefined()
    expect(calls).toBe(2)
  })

  test("gives up at the timeout with the last status", async () => {
    let t = 0
    const final = await pollCommand(7, {
      fetch: async () => ({ id: 7, state: "pending" }),
      signal: new AbortController().signal,
      timeoutMs: 3000,
      intervalMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
    })
    expect(final?.state).toBe("pending")
    expect(t).toBe(3000)
  })

  test("a 404 (row cleaned up or route missing) ends polling", async () => {
    const final = await pollCommand(7, {
      fetch: async () => {
        throw new ApiError("not found", 404)
      },
      signal: new AbortController().signal,
      sleep: instant,
    })
    expect(final).toBeUndefined()
  })

  test("transient errors are retried, then given up", async () => {
    let calls = 0
    const final = await pollCommand(7, {
      fetch: async () => {
        calls++
        throw new ApiError("Memory API unreachable", 0)
      },
      signal: new AbortController().signal,
      sleep: instant,
    })
    expect(final).toBeUndefined()
    expect(calls).toBe(3)
  })
})
