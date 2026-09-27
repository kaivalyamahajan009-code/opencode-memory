import { describe, expect, test } from "bun:test"
import { activePauseReason, deriveMemoryState, isRecentFailure, pauseReason, pausedBannerText, statusTitle } from "../src/status"
import type { GlobalStatus, SessionStatus } from "../src/types"

function global(over: Partial<GlobalStatus> = {}): GlobalStatus {
  return {
    byScope: [],
    reviewOpen: 0,
    quarantined: 0,
    queued: 0,
    vaultPending: 0,
    topicConflicts: 0,
    usage: { costUsd: 0, tokens: 0, reservedUsd: 0, runs: 0, failures: 0 },
    cap: { usd: 1, tokens: 1 },
    recentFailures: [],
    instances: [],
    paused: false,
    observing: false,
    fts5: true,
    driver: "bun:sqlite",
    embeddings: null,
    dataDir: "/tmp",
    vaultDir: "/tmp/vault",
    ...over,
  }
}

function session(over: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "s",
    known: true,
    projectId: null,
    title: null,
    capturedTokens: 0,
    unobservedTokens: 0,
    unchunkedTokens: 0,
    oldestUnobservedAt: null,
    bufferTokens: 0,
    activationTokens: 30_000,
    lastSeq: 0,
    chunkedSeq: 0,
    coveredSeq: 0,
    chunks: {},
    observations: 0,
    observationTokens: 0,
    injectedTokens: 0,
    injectedAt: null,
    currentTask: null,
    suggestedNext: null,
    lastError: null,
    paused: false,
    excluded: false,
    internal: false,
    reverted: false,
    forkedFrom: null,
    observing: false,
    ...over,
  }
}

describe("deriveMemoryState", () => {
  const now = 1_700_000_000_000

  test("idle when empty global", () => {
    expect(deriveMemoryState(undefined, undefined, now)).toBe("idle")
  })

  test("paused wins", () => {
    expect(deriveMemoryState(global({ paused: true }), session(), now)).toBe("paused")
    expect(deriveMemoryState(global(), session({ paused: true }), now)).toBe("paused")
  })

  test("old recentFailures do not keep the pill in error", () => {
    const g = global({
      recentFailures: [{ kind: "observe", error: "boom", error_class: "x", started_at: now - 60 * 60_000 }],
    })
    expect(isRecentFailure(g, session(), now)).toBe(false)
    expect(deriveMemoryState(g, session(), now)).toBe("idle")
  })

  test("error if lastFailureAt is newer than lastSuccessAt", () => {
    const g = global({ lastFailureAt: now - 1000, lastSuccessAt: now - 5000 })
    expect(deriveMemoryState(g, session(), now)).toBe("error")
  })

  test("not error if lastSuccessAt is newer than lastFailureAt", () => {
    const g = global({
      lastFailureAt: now - 5000,
      lastSuccessAt: now - 1000,
      recentFailures: [{ kind: "observe", error: "old", error_class: "x", started_at: now - 5000 }],
    })
    expect(deriveMemoryState(g, session(), now)).toBe("idle")
  })

  test("failure within 15 minutes is error when timestamps absent", () => {
    const g = global({
      recentFailures: [{ kind: "observe", error: "boom", error_class: "x", started_at: now - 5 * 60_000 }],
    })
    expect(deriveMemoryState(g, session(), now)).toBe("error")
  })

  test("quarantined counts as error", () => {
    expect(deriveMemoryState(global({ quarantined: 2 }), session(), now)).toBe("error")
  })

  test("session.lastError counts as error", () => {
    expect(
      deriveMemoryState(
        global(),
        session({ lastError: { error: "nope", error_class: "x", updated_at: now - 86_400_000 } }),
        now,
      ),
    ).toBe("error")
  })

  test("never infers reflecting from vaultPending", () => {
    expect(deriveMemoryState(global({ vaultPending: 9 }), session(), now)).toBe("idle")
  })

  test("reflecting only from global.reflecting", () => {
    expect(deriveMemoryState(global({ reflecting: true, vaultPending: 0 }), session(), now)).toBe("reflecting")
  })

  test("observing wins over stale failure", () => {
    expect(deriveMemoryState(global({ observing: true, quarantined: 1 }), session(), now)).toBe("observing")
  })

  test("buffering from queued/unobserved", () => {
    expect(deriveMemoryState(global({ queued: 1 }), session(), now)).toBe("buffering")
    expect(deriveMemoryState(global(), session({ unobservedTokens: 10 }), now)).toBe("buffering")
  })
})

describe("pausedReason", () => {
  const now = 1_700_000_000_000

  test("a user pause reports 'manual' (what engine.setPaused(true) writes); a missing reason counts as manual", () => {
    expect(pauseReason(global({ paused: true, pausedReason: "manual" }))).toBe("manual")
    expect(pauseReason(global({ paused: true, pausedReason: null }))).toBe("manual")
    expect(pauseReason(global({ paused: true, pausedReason: "   " }))).toBe("manual")
    expect(pauseReason(global({ paused: false, pausedReason: "manual" }))).toBeUndefined()
  })

  test("only non-manual reasons need attention, and only while globally paused", () => {
    expect(activePauseReason(global({ paused: true, pausedReason: "auth" }))).toBe("auth")
    expect(activePauseReason(global({ paused: true, pausedReason: "manual" }))).toBeUndefined()
    expect(activePauseReason(global({ paused: true, pausedReason: "Manual" }))).toBeUndefined()
    expect(activePauseReason(global({ paused: false, pausedReason: "auth" }))).toBeUndefined()
    expect(activePauseReason(global({ paused: true, pausedReason: null }))).toBeUndefined()
    expect(activePauseReason(undefined)).toBeUndefined()
  })

  test("{ paused: true, pausedReason: 'manual' } shows no warning banner and a plain Paused title", () => {
    const g = global({ paused: true, pausedReason: "manual" })
    expect(pausedBannerText(g)).toBe("")
    expect(statusTitle(deriveMemoryState(g, session(), now), g, session())).toBe("Paused")
  })

  test("{ paused: true, pausedReason: 'auth' } shows the auth banner", () => {
    const g = global({ paused: true, pausedReason: "auth" })
    expect(pausedBannerText(g)).toBe("Paused: authentication failed — check your observer model credentials, then Resume.")
    expect(statusTitle(deriveMemoryState(g, session(), now), g, session())).toBe("Paused: authentication failed")
  })

  test("cost-cap and error reasons get friendly copy; unknown reasons a generic fallback", () => {
    expect(pausedBannerText(global({ paused: true, pausedReason: "cost-cap" }))).toBe(
      "Paused: the daily cost cap was reached — raise it in Settings or wait until tomorrow, then Resume.",
    )
    expect(pausedBannerText(global({ paused: true, pausedReason: "budget" }))).toContain("daily cost cap")
    expect(pausedBannerText(global({ paused: true, pausedReason: "error" }))).toBe("Paused after repeated errors — check Runs for details, then Resume.")
    expect(pausedBannerText(global({ paused: true, pausedReason: "maintenance" }))).toBe("Paused: maintenance — fix the cause, then Resume.")
  })

  test("no banner when resumed with a stale reason", () => {
    expect(pausedBannerText(global({ paused: false, pausedReason: "auth" }))).toBe("")
    expect(pausedBannerText(global({ paused: true }))).toBe("")
    expect(pausedBannerText(global())).toBe("")
  })

  test("pill title carries the reason only in the paused state", () => {
    const resumed = global({ paused: false, pausedReason: "auth" })
    expect(statusTitle(deriveMemoryState(resumed, session(), now), resumed, session())).toBe("Idle")
    expect(statusTitle("paused", global({ paused: true }), session())).toBe("Paused")
    expect(statusTitle("paused", global(), session({ paused: true }))).toBe("Paused for this session")
  })
})
