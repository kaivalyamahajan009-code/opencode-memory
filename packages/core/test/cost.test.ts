import { afterAll, describe, expect, test } from "bun:test"
import { CUT, T0, FakeRunner, RunnerError, assistantMsg, cleanupAllTempDirs, defaultConfig, ingest, openHarness, seed, userMsg } from "./helpers"
import { reserveRun, usageToday } from "../src/cost"
import { cutChunks } from "../src/chunks"
import { observeNext } from "../src/observer"

afterAll(cleanupAllTempDirs)

describe("cost cap", () => {
  test("reserveRun throws cost_limit when the daily cap would be exceeded", async () => {
    const h = await openHarness()
    try {
      expect(() =>
        reserveRun(h.db, { dailyCapUsd: 0.001, dailyTokenCap: 2_000_000, estimatePerRunUsd: 0.01 }, { kind: "observe", runner: "fake" }, T0),
      ).toThrow(RunnerError)
      try {
        reserveRun(h.db, { dailyCapUsd: 0.001, dailyTokenCap: 2_000_000, estimatePerRunUsd: 0.01 }, { kind: "observe", runner: "fake" }, T0)
      } catch (e) {
        expect(e).toBeInstanceOf(RunnerError)
        expect((e as RunnerError).cls).toBe("cost_limit")
      }
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM operations").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("observeNext pauses the chunk without counting an attempt when the cap is hit", async () => {
    const h = await openHarness()
    try {
      const { sessionId } = seed(h.db)
      ingest(h.db, sessionId, [userMsg("cost cap please", { id: "u1" }), assistantMsg("ok", { id: "a1", at: T0 + 1 })])
      cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })
      const pending = h.db.prepare("SELECT attempts, state FROM chunks").get<{ attempts: number; state: string }>()!
      expect(pending.state).toBe("pending")
      expect(pending.attempts).toBe(0)
      const cfg = defaultConfig(h.dir)
      cfg.cost.dailyCapUsd = 0.001
      cfg.cost.estimatePerRunUsd = 0.05
      const runner = new FakeRunner().always({ observations: [] })
      const r = await observeNext({ db: h.db, config: cfg, runner, owner: "w1", now: () => T0 + 5 })
      expect(r?.status).toBe("paused")
      expect(r && "cls" in r ? r.cls : undefined).toBe("cost_limit")
      const row = h.db.prepare("SELECT attempts, state FROM chunks").get<{ attempts: number; state: string }>()!
      expect(row.attempts).toBe(0)
      expect(row.state).toBe("pending")
      expect(runner.requests.length).toBe(0)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM coverage").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("a reserved run counts against the cap until it settles", async () => {
    const h = await openHarness()
    try {
      const id = reserveRun(h.db, { dailyCapUsd: 1, dailyTokenCap: 2_000_000, estimatePerRunUsd: 0.4 }, { kind: "observe", runner: "fake" }, T0)
      expect(id).toBeTruthy()
      const u = usageToday(h.db, T0)
      expect(u.reservedUsd).toBeCloseTo(0.4, 5)
      expect(() => reserveRun(h.db, { dailyCapUsd: 0.5, dailyTokenCap: 2_000_000, estimatePerRunUsd: 0.2 }, { kind: "observe", runner: "fake" }, T0)).toThrow()
    } finally {
      h.close()
    }
  })
})
