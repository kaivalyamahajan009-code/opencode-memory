import "./hermetic"
import { afterAll, describe, expect, test } from "bun:test"
import {
  RunnerError,
  cutChunks,
  ingestMessages,
  mergeConfig,
  observeNext,
  type RunRequest,
  upsertProject,
  upsertSession,
  usageToday,
} from "@opencode-memory/core"
import {
  T0,
  ScriptedRunner,
  assistantMessage,
  cleanupAll,
  cleanupDir,
  count,
  openEngine,
  outputForFirstRef,
  userMessage,
} from "./fixtures"

afterAll(cleanupAll)

async function pendingSession(id: string, messageCount: number, patch: unknown = {}) {
  const h = await openEngine({ patch: mergeConfig({ observe: { maxChunkTokens: 10_000 } }, patch) })
  upsertProject(h.engine.db, { id: "project-a", workspace: "workspace-a", domain: "general", directory: h.dir }, T0)
  upsertSession(h.engine.db, { id, projectId: "project-a", title: id }, T0)
  const messages = Array.from({ length: messageCount }, (_, index) =>
    index % 2
      ? assistantMessage(id, `a${index}`, `assistant evidence ${index} `.repeat(3), T0 + index)
      : userMessage(id, `u${index}`, `user evidence ${index} `.repeat(3), T0 + index),
  )
  ingestMessages(h.engine.db, id, messages, {
    captureReasoning: false,
    toolOutputMax: 4_000,
    staleIncompleteMs: 60_000,
    now: T0,
  })
  cutChunks(h.engine.db, id, "explicit", {
    bufferTokens: 10_000,
    maxChunkTokens: 10_000,
    minFlushTokens: 1,
    now: T0,
  })
  return h
}

describe("acceptance: observer validation and failure recovery", () => {
  test("retries malformed output, splits the range, then merges repetitive child observations", async () => {
    const h = await pendingSession("malformed-session", 4, { observe: { maxAttempts: 2 } })
    let now = T0
    const malformed = { observations: [{ kind: "fact", content: "missing sources" }] }
    const runner = new ScriptedRunner([
      malformed,
      malformed,
      (request: RunRequest) => outputForFirstRef(request, "Repeated durable result from split chunks"),
      (request: RunRequest) => outputForFirstRef(request, "Repeated durable result from split chunks"),
    ])
    const run = () =>
      observeNext({
        db: h.engine.db,
        config: h.config,
        runner,
        owner: "acceptance-worker",
        now: () => now,
      })
    try {
      expect((await run())?.status).toBe("retry")
      expect(count(h.engine, "coverage")).toBe(0)
      now += 60 * 60_000
      expect((await run())?.status).toBe("split")
      expect(count(h.engine, "coverage")).toBe(0)
      const states = h.engine.db.prepare("SELECT state, COUNT(*) AS n FROM chunks GROUP BY state").all<{ state: string; n: number }>()
      expect(states).toEqual(expect.arrayContaining([{ state: "pending", n: 2 }, { state: "split", n: 1 }]))

      now += 60 * 60_000
      expect((await run())?.status).toBe("succeeded")
      expect((await run())?.status).toBe("succeeded")
      expect(count(h.engine, "coverage")).toBe(2)
      expect(count(h.engine, "observations")).toBe(1)
      const sourceCount = h.engine.db
        .prepare("SELECT COUNT(*) AS n FROM observation_sources")
        .get<{ n: number }>()!.n
      expect(sourceCount).toBe(2)
      expect(usageToday(h.engine.db, now)).toMatchObject({ runs: 4, failures: 2 })
    } finally {
      await h.engine.close()
      cleanupDir(h.dir)
    }
  })

  test("quarantines a malformed singleton with a precise failure marker and no false coverage", async () => {
    const h = await pendingSession("quarantine-session", 1, { observe: { maxAttempts: 1 } })
    const runner = new ScriptedRunner([{ observations: [{ nope: true }] }])
    try {
      const outcome = await observeNext({
        db: h.engine.db,
        config: h.config,
        runner,
        owner: "acceptance-worker",
        now: () => T0 + 1,
      })
      expect(outcome?.status).toBe("quarantined")
      expect(count(h.engine, "coverage")).toBe(0)
      expect(count(h.engine, "observations")).toBe(0)
      const marker = h.engine.db
        .prepare("SELECT state, attempts, error_class, error FROM chunks")
        .get<{ state: string; attempts: number; error_class: string; error: string }>()!
      expect(marker).toMatchObject({ state: "quarantined", attempts: 1, error_class: "invalid_output" })
      expect(marker.error).toContain("malformed")
    } finally {
      await h.engine.close()
      cleanupDir(h.dir)
    }
  })

  test("accounts partial paid usage when a runner fails before producing output", async () => {
    const h = await pendingSession("partial-usage-session", 1)
    const paidFailure = Object.assign(new RunnerError("transient", "provider disconnected after generation"), {
      inputTokens: 41,
      outputTokens: 17,
      cost: 0.012,
      model: "fake/paid-failure",
    })
    const runner = new ScriptedRunner([paidFailure])
    try {
      const outcome = await observeNext({
        db: h.engine.db,
        config: h.config,
        runner,
        owner: "acceptance-worker",
        now: () => T0 + 1,
      })
      expect(outcome?.status).toBe("retry")
      expect(usageToday(h.engine.db, T0 + 1)).toEqual({
        costUsd: 0.012,
        tokens: 58,
        reservedUsd: 0,
        runs: 1,
        failures: 1,
      })
      expect(count(h.engine, "coverage")).toBe(0)
    } finally {
      await h.engine.close()
      cleanupDir(h.dir)
    }
  })
})
