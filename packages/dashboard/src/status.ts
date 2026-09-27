import type { GlobalStatus, MemoryState, SessionStatus } from "./types"

const FIFTEEN_MIN = 15 * 60_000

export function newestFailureAt(global?: GlobalStatus, session?: SessionStatus): number | undefined {
  const times: number[] = []
  if (global?.lastFailureAt) times.push(global.lastFailureAt)
  if (session?.lastError?.updated_at) times.push(session.lastError.updated_at)
  for (const f of global?.recentFailures ?? []) {
    if (typeof f.started_at === "number") times.push(f.started_at)
  }
  if (!times.length) return undefined
  return Math.max(...times)
}

export function isRecentFailure(global?: GlobalStatus, session?: SessionStatus, now = Date.now()): boolean {
  if ((global?.quarantined ?? 0) > 0) return true
  if (session?.lastError) return true
  const failAt = newestFailureAt(global, session)
  if (failAt == null) return false
  if (global?.lastFailureAt != null || global?.lastSuccessAt != null) {
    const lastFail = global.lastFailureAt ?? failAt
    const lastOk = global.lastSuccessAt
    if (lastOk != null && lastFail <= lastOk) return false
    if (lastOk != null && lastFail > lastOk) return true
  }
  return now - failAt <= FIFTEEN_MIN
}

export function deriveMemoryState(global?: GlobalStatus, session?: SessionStatus, now = Date.now()): MemoryState {
  if (!global) return "idle"
  if (global.paused || session?.paused) return "paused"
  if (isRecentFailure(global, session, now) && !global.observing && !session?.observing && !global.reflecting) return "error"
  if (global.observing || session?.observing) return "observing"
  if (global.reflecting) return "reflecting"
  const queued = global.queued ?? 0
  const unchunked = session?.unchunkedTokens ?? 0
  const unobserved = session?.unobservedTokens ?? 0
  if (queued > 0 || unchunked > 0 || unobserved > 0) return "buffering"
  return "idle"
}

export const STATE_LABEL: Record<MemoryState, string> = {
  idle: "Idle",
  buffering: "Buffering",
  observing: "Observing",
  reflecting: "Reflecting",
  paused: "Paused",
  error: "Error",
}

const AUTH_REASON = /^auth$|auth(entication)? failed|unauthori[sz]ed|credential|api.?key/i
const COST_REASON = /cost|budget|\bcap\b|spend/i
const ERROR_REASON = /error|fail/i

/** Why memory is globally paused; "manual" (what a user pause writes) when no reason is given. Undefined unless paused. */
export function pauseReason(global?: GlobalStatus): string | undefined {
  if (!global?.paused) return undefined
  const reason = typeof global.pausedReason === "string" ? global.pausedReason.trim() : ""
  return reason || "manual"
}

/** A pause reason that needs the user's attention: anything but a manual pause. */
export function activePauseReason(global?: GlobalStatus): string | undefined {
  const reason = pauseReason(global)
  return reason && reason.toLowerCase() !== "manual" ? reason : undefined
}

export function describePauseReason(reason: string): string {
  if (AUTH_REASON.test(reason)) return "authentication failed"
  if (COST_REASON.test(reason)) return "daily cost cap reached"
  if (ERROR_REASON.test(reason)) return "repeated errors"
  return reason
}

export function pausedBannerText(global?: GlobalStatus): string {
  const reason = activePauseReason(global)
  if (!reason) return ""
  if (AUTH_REASON.test(reason)) return "Paused: authentication failed — check your observer model credentials, then Resume."
  if (COST_REASON.test(reason)) return "Paused: the daily cost cap was reached — raise it in Settings or wait until tomorrow, then Resume."
  if (ERROR_REASON.test(reason)) return "Paused after repeated errors — check Runs for details, then Resume."
  return `Paused: ${reason} — fix the cause, then Resume.`
}

export function statusTitle(state: MemoryState, global?: GlobalStatus, session?: SessionStatus): string {
  if (state !== "paused") return STATE_LABEL[state]
  const reason = activePauseReason(global)
  if (reason) return `Paused: ${describePauseReason(reason)}`
  if (!global?.paused && session?.paused) return "Paused for this session"
  return STATE_LABEL.paused
}
