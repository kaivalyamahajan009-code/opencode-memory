import { describe, expect, test } from "bun:test"
import { baselineAfterSave, buildSettingsPatch, MIN_TIMER_MS, parseNumber, parseTimer, serverFieldError } from "../src/settings-fields"
import type { MemoryConfigView } from "../src/types"

test("dashboard backup config does not advertise the server-hidden data directory", () => {
  const backupHasDir: "dir" extends keyof NonNullable<MemoryConfigView["backup"]> ? true : false = false
  expect(backupHasDir).toBe(false)
})

describe("parseNumber", () => {
  test("rejects empty, junk, and non-positive by default", () => {
    expect(parseNumber("")).toEqual({ ok: false, error: "Required" })
    expect(parseNumber("30k")).toEqual({ ok: false, error: "Enter a number" })
    expect(parseNumber("0")).toEqual({ ok: false, error: "Must be greater than zero" })
    expect(parseNumber("-1")).toEqual({ ok: false, error: "Must be greater than zero" })
  })

  test("allows zero when requested and rejects non-integers when asked", () => {
    expect(parseNumber("0", { allowZero: true })).toEqual({ ok: true, value: 0 })
    expect(parseNumber("1.5", { integer: true })).toEqual({ ok: false, error: "Enter a whole number" })
  })

  test("accepts positive integers", () => {
    expect(parseNumber("30000")).toEqual({ ok: true, value: 30000 })
  })
})

describe("buildSettingsPatch", () => {
  const current = {
    observe: { activationTokens: 30000, bufferTokens: 6000 },
    reflect: { thresholdTokens: 40000 },
    cost: { dailyCapUsd: 1, dailyTokenCap: 2_000_000 },
    runner: { kind: "opencode-session", model: { providerID: "opencode", modelID: "small" } },
    inject: { budget: { session: 2400, recall: 900 } },
    pruning: { enabled: false, keepRecentTurns: 4 },
  }

  const valid = {
    activationTokens: "30000",
    bufferTokens: "6000",
    reflectTokens: "40000",
    dailyCapUsd: "1",
    dailyTokenCap: "2000000",
    runnerKind: "opencode-session",
    providerID: "opencode",
    modelID: "small",
    budgetSession: "2400",
    budgetRecall: "900",
    pruning: false,
    keepRecentTurns: "4",
  }

  test("empty patch when unchanged", () => {
    const r = buildSettingsPatch(valid, current)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.patch).toEqual({})
  })

  test("sends only changed fields", () => {
    const r = buildSettingsPatch({ ...valid, activationTokens: "31000", dailyCapUsd: "0" }, current)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.patch).toEqual({
        observe: { activationTokens: 31000 },
        cost: { dailyCapUsd: 0 },
      })
    }
  })

  test("allows zero activation for immediate automatic observation", () => {
    const r = buildSettingsPatch({ ...valid, activationTokens: "0" }, current)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.patch).toEqual({ observe: { activationTokens: 0 } })
  })

  test("blocks save on invalid fields", () => {
    const r = buildSettingsPatch({ ...valid, activationTokens: "30k" }, current)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.activationTokens).toBe("Enter a number")
  })

  const timed = {
    ...current,
    runner: { ...current.runner, timeoutMs: 180_000 },
    observe: { ...current.observe, leaseMs: 300_000 },
  }
  const timers = { ...valid, runnerTimeoutMs: "180000", reflectorTimeoutMs: "", leaseMs: "300000" }

  test("timers under 1000 ms are refused inline before anything is sent", () => {
    const r = buildSettingsPatch({ ...timers, runnerTimeoutMs: "999", reflectorTimeoutMs: "10", leaseMs: "0" }, timed)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors).toEqual({
        runnerTimeoutMs: `Must be at least ${MIN_TIMER_MS} ms`,
        reflectorTimeoutMs: `Must be at least ${MIN_TIMER_MS} ms`,
        leaseMs: "Must be greater than zero",
      })
    }
    const whole = buildSettingsPatch({ ...timers, leaseMs: "1500.5" }, timed)
    if (!whole.ok) expect(whole.errors.leaseMs).toBe("Enter a whole number")
    expect(parseTimer("1000")).toEqual({ ok: true, value: 1000 })
  })

  test("changed timers land in their sections; an empty reflector timeout follows the runner", () => {
    const same = buildSettingsPatch(timers, timed)
    if (same.ok) expect(same.patch).toEqual({})
    const r = buildSettingsPatch({ ...timers, runnerTimeoutMs: "60000", reflectorTimeoutMs: "90000", leaseMs: "1000" }, timed)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.patch).toEqual({
        observe: { leaseMs: 1000 },
        runner: { timeoutMs: 60000 },
        reflectorRunner: { timeoutMs: 90000 },
      })
    }
    const untouched = buildSettingsPatch(valid, timed)
    if (untouched.ok) expect(untouched.patch).toEqual({})
  })

  test("a server timer refusal is placed under its field", () => {
    expect(serverFieldError("runner.timeoutMs must be at least 1000 ms")).toEqual({ key: "runnerTimeoutMs", text: `Must be at least ${MIN_TIMER_MS} ms` })
    expect(serverFieldError("invalid config observe.leaseMs: Too small: expected number to be >=1000")?.key).toBe("leaseMs")
    expect(serverFieldError("reflectorRunner.timeoutMs must be at least 1000 ms")?.key).toBe("reflectorTimeoutMs")
    expect(serverFieldError("config.json is not valid JSON; fix or remove it before saving settings")).toBeUndefined()
    expect(serverFieldError("runner.timeoutMs must be a number")).toBeUndefined()
  })
})

describe("baselineAfterSave", () => {
  const current = {
    observe: { activationTokens: 30000, bufferTokens: 6000 },
    reflect: { thresholdTokens: 40000 },
    cost: { dailyCapUsd: 1, dailyTokenCap: 2_000_000 },
    runner: { kind: "opencode-session", model: { providerID: "opencode", modelID: "small" }, direct: { headers: { Authorization: "***" } } },
    inject: { budget: { session: 2400, recall: 900 } },
    pruning: { enabled: false, keepRecentTurns: 4 },
  }
  const original = {
    activationTokens: "30000",
    bufferTokens: "6000",
    reflectTokens: "40000",
    dailyCapUsd: "1",
    dailyTokenCap: "2000000",
    runnerKind: "opencode-session",
    providerID: "opencode",
    modelID: "small",
    budgetSession: "2400",
    budgetRecall: "900",
    pruning: false,
    keepRecentTurns: "4",
  }
  const edited = { ...original, activationTokens: "31000", budgetRecall: "1200" }

  function saved() {
    const r = buildSettingsPatch(edited, current)
    if (!r.ok) throw new Error("expected a valid patch")
    return r.patch
  }

  test("reverting after a save diffs against the config the server returned", () => {
    const patch = saved()
    const returned = { ...current, observe: { ...current.observe, activationTokens: 31000 }, inject: { budget: { session: 2400, recall: 1200 } } }
    const baseline = baselineAfterSave(current, returned, patch)
    expect(baseline).toBe(returned)
    const revert = buildSettingsPatch(original, baseline)
    expect(revert.ok).toBe(true)
    if (revert.ok) expect(revert.patch).toEqual({ observe: { activationTokens: 30000 }, inject: { budget: { recall: 900 } } })
  })

  test("without a config in the response the patch is merged into the old baseline", () => {
    const patch = saved()
    const baseline = baselineAfterSave(current, { done: true }, patch)
    expect(baseline.observe).toEqual({ activationTokens: 31000, bufferTokens: 6000 })
    expect(baseline.inject?.budget).toEqual({ session: 2400, recall: 1200 })
    expect(baseline.runner?.direct?.headers).toEqual({ Authorization: "***" })
    const revert = buildSettingsPatch(original, baseline)
    if (revert.ok) expect(revert.patch).toEqual({ observe: { activationTokens: 30000 }, inject: { budget: { recall: 900 } } })
    const again = buildSettingsPatch(edited, baseline)
    if (again.ok) expect(again.patch).toEqual({})
  })

  test("the stale pre-save baseline would have reported no changes", () => {
    const stale = buildSettingsPatch(original, current)
    if (stale.ok) expect(stale.patch).toEqual({})
  })
})
