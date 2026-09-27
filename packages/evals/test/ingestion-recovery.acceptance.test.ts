import "./hermetic"
import { afterAll, describe, expect, test } from "bun:test"
import { claimChunk, contiguousCoverage, cutChunks, type RunRequest } from "@opencode-memory/core"
import {
  T0,
  ScriptedRunner,
  adapter,
  cleanupAll,
  cleanupDir,
  count,
  longMessages,
  openEngine,
  outputForFirstRef,
  tempDir,
  userMessage,
} from "./fixtures"

afterAll(cleanupAll)

describe("acceptance: long-session ingestion and recovery", () => {
  test("crosses activation and chunk thresholds, drains completely, and re-ingests idempotently", async () => {
    const runner = new ScriptedRunner([(request: RunRequest) => outputForFirstRef(request)])
    const h = await openEngine({ runner })
    const messages = longMessages("long-session", 20, 30)
    const instance = adapter({ runner, directory: h.dir, messages })
    try {
      h.engine.register(instance, T0)
      h.engine.trackSession(instance, { id: "long-session", title: "Long acceptance session" }, T0)
      const first = h.engine.ingest("long-session", messages, { full: true, now: T0 })
      expect(first?.captured).toBe(20)
      expect(h.engine.sessionStatus("long-session").capturedTokens).toBeGreaterThan(h.config.observe.activationTokens)

      const flushed = await h.engine.flush("long-session", { wait: true, timeoutMs: 10_000 })
      expect(flushed.waited).toBe(true)
      expect(flushed.outcomes.every((outcome) => outcome.status === "succeeded")).toBe(true)
      const status = h.engine.sessionStatus("long-session")
      expect(status.lastSeq).toBe(20)
      expect(status.coveredSeq).toBe(20)
      expect(status.unchunkedTokens).toBe(0)
      expect(status.chunks.succeeded?.n).toBeGreaterThan(1)
      expect(runner.requests.length).toBeGreaterThan(1)

      const before = {
        messages: count(h.engine, "source_messages"),
        parts: count(h.engine, "source_parts"),
        chunks: count(h.engine, "chunks"),
        operations: count(h.engine, "operations"),
      }
      const again = h.engine.ingest("long-session", messages, { full: true, now: T0 + 1_000 })
      expect(again?.captured).toBe(0)
      await h.engine.flush("long-session", { wait: true, timeoutMs: 10_000 })
      expect({
        messages: count(h.engine, "source_messages"),
        parts: count(h.engine, "source_parts"),
        chunks: count(h.engine, "chunks"),
        operations: count(h.engine, "operations"),
      }).toEqual(before)
    } finally {
      await h.engine.close()
      cleanupDir(h.dir)
    }
  }, 15_000)

  test("reopens an interrupted database, reclaims an expired lease, and finishes uncovered work", async () => {
    const dir = tempDir()
    const dbPath = `${dir}\\memory.db`
    const first = await openEngine({ dir, dbPath, runner: new ScriptedRunner() })
    const messages = [userMessage("crash-session", "u1", "recoverable context after interruption", T0)]
    const firstAdapter = adapter({ runner: first.runner, directory: dir, messages })
    try {
      first.engine.trackSession(firstAdapter, { id: "crash-session" }, T0)
      first.engine.ingest("crash-session", messages, { now: T0 })
      const chunks = cutChunks(first.engine.db, "crash-session", "explicit", {
        bufferTokens: 1_000,
        maxChunkTokens: 1_000,
        minFlushTokens: 1,
        now: T0,
      })
      expect(chunks).toHaveLength(1)
      const abandoned = claimChunk(first.engine.db, "dead-process", { leaseMs: 1_000, now: Date.now() - 10_000 })
      expect(abandoned?.chunk.state).toBe("running")
    } finally {
      await first.engine.close()
    }

    const recoveryRunner = new ScriptedRunner([(request: RunRequest) => outputForFirstRef(request, "Recovered after an interrupted observer run")])
    const reopened = await openEngine({ dir, dbPath, runner: recoveryRunner })
    const recoveryAdapter = adapter({ runner: recoveryRunner, directory: dir, messages })
    try {
      reopened.engine.register(recoveryAdapter, T0 + 10_000)
      await reopened.engine.drain("project-a")
      expect(recoveryRunner.requests.length).toBeGreaterThanOrEqual(1)
      expect(contiguousCoverage(reopened.engine.db, "crash-session")).toBe(1)
      expect(reopened.engine.search(reopened.engine.context("project-a", "crash-session"), "interrupted observer").length).toBe(1)
    } finally {
      await reopened.engine.close()
      cleanupDir(dir)
    }
  })

  test("coalesces concurrent drains into one project-level model flight", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const runner = new ScriptedRunner([
      async (request: RunRequest) => {
        await gate
        return outputForFirstRef(request, "Single flight result")
      },
    ])
    const h = await openEngine({ runner })
    const messages = [userMessage("single-flight", "u1", "one meaningful message for observation")]
    const instance = adapter({ runner, directory: h.dir, messages })
    try {
      h.engine.register(instance, T0)
      h.engine.trackSession(instance, { id: "single-flight" }, T0)
      h.engine.ingest("single-flight", messages, { now: T0 })
      cutChunks(h.engine.db, "single-flight", "explicit", {
        bufferTokens: 1_000,
        maxChunkTokens: 1_000,
        minFlushTokens: 1,
        now: T0,
      })
      const a = h.engine.drain("project-a")
      const b = h.engine.drain("project-a")
      expect(a).toBe(b)
      release()
      const [left, right] = await Promise.all([a, b])
      expect(left).toEqual(right)
      expect(runner.requests).toHaveLength(1)
      expect(contiguousCoverage(h.engine.db, "single-flight")).toBe(1)
    } finally {
      release()
      await h.engine.close()
      cleanupDir(h.dir)
    }
  })
})
