import { describe, expect, test } from "bun:test"
import { createPollScheduler } from "../src/poll-scheduler"

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

function harness(opts: { canRun?: () => boolean; key?: () => string } = {}) {
  const calls: Deferred<string>[] = []
  const data: string[] = []
  const errors: unknown[] = []
  const scheduler = createPollScheduler<string>({
    fn: () => {
      const d = deferred<string>()
      calls.push(d)
      return d.promise
    },
    canRun: opts.canRun ?? (() => true),
    key: opts.key,
    onData: (v) => data.push(v),
    onError: (e) => errors.push(e),
  })
  return { scheduler, calls, data, errors }
}

describe("createPollScheduler", () => {
  test("reload with nothing in flight fetches exactly once", async () => {
    const h = harness()
    const done = h.scheduler.reload()
    expect(h.calls.length).toBe(1)
    h.calls[0].resolve("a")
    await done
    await settle()
    expect(h.calls.length).toBe(1)
    expect(h.data).toEqual(["a"])
  })

  test("reloads during a request queue exactly one follow-up and resolve after it", async () => {
    const h = harness()
    const first = h.scheduler.tick()
    let reloaded = false
    const r1 = h.scheduler.reload().then(() => {
      reloaded = true
    })
    const r2 = h.scheduler.reload()
    expect(h.calls.length).toBe(1)
    h.calls[0].resolve("a")
    await settle()
    expect(h.calls.length).toBe(2)
    expect(reloaded).toBe(false)
    h.calls[1].resolve("b")
    await Promise.all([first, r1, r2])
    await settle()
    expect(reloaded).toBe(true)
    expect(h.calls.length).toBe(2)
    expect(h.data).toEqual(["a", "b"])
  })

  test("background ticks during a request are dropped", async () => {
    const h = harness()
    const first = h.scheduler.tick()
    void h.scheduler.tick()
    void h.scheduler.tick()
    h.calls[0].resolve("a")
    await first
    await settle()
    expect(h.calls.length).toBe(1)
  })

  test("a response for a previous session is discarded and refetched", async () => {
    let key = "s1"
    const h = harness({ key: () => key })
    void h.scheduler.tick()
    key = "s2"
    h.calls[0].resolve("old-session")
    await settle()
    expect(h.data).toEqual([])
    expect(h.calls.length).toBe(2)
    h.calls[1].resolve("new-session")
    await settle()
    expect(h.data).toEqual(["new-session"])
  })

  test("an error for a previous session is discarded too", async () => {
    let key = "s1"
    const h = harness({ key: () => key })
    void h.scheduler.tick()
    key = "s2"
    h.calls[0].reject(new Error("old boom"))
    await settle()
    expect(h.errors).toEqual([])
    h.calls[1].resolve("fresh")
    await settle()
    expect(h.data).toEqual(["fresh"])
  })

  test("reset discards whatever is in flight", async () => {
    const h = harness()
    void h.scheduler.tick()
    h.scheduler.reset()
    h.calls[0].resolve("stale")
    await settle()
    expect(h.data).toEqual([])
  })

  test("background ticks respect canRun; reload does not", async () => {
    const h = harness({ canRun: () => false })
    await h.scheduler.tick()
    expect(h.calls.length).toBe(0)
    const r = h.scheduler.reload()
    expect(h.calls.length).toBe(1)
    h.calls[0].resolve("forced")
    await r
    expect(h.data).toEqual(["forced"])
  })
})
