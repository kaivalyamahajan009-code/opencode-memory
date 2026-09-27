import { ApiError } from "./api-unwrap"
import type { ForgetResult } from "./types"

export function forgetSelection(rowId: string, tickedIds: string[]): string[] {
  const extra = tickedIds.filter((id) => id && id !== rowId)
  return [rowId, ...extra]
}

export const PURGE_SOURCES_DEFAULT = false

export function forgetRequest(
  rowId: string,
  tickedIds: string[],
  purge = PURGE_SOURCES_DEFAULT,
): { ids: string[]; purgeSources: "sources" | "none" } {
  return { ids: forgetSelection(rowId, tickedIds), purgeSources: purge ? "sources" : "none" }
}

export type ForgetBody = { ids: string[]; confirm: true; reason: string; purgeSources: "sources" | "none" }

/**
 * A user forget is global: the body never names a session or project, because the server then
 * runs a scoped (agent-style) forget that leaves other copies and non-active rows behind.
 */
export function forgetBody(req: { ids: string[]; purgeSources: "sources" | "none" }, reason = "dashboard forget"): ForgetBody {
  return { ids: [...req.ids], confirm: true, reason, purgeSources: req.purgeSources }
}

export function forgetCandidatesBody(text: string): { text: string } {
  return { text }
}

function memories(n: number): string {
  return `${n} selected ${n === 1 ? "memory" : "memories"}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0
}

export function purgeLabel(n: number): string {
  return `Also delete the cited conversation parts for the ${memories(n)} (other memories may rely on them)`
}

/**
 * `complete` closes the dialog; otherwise the message stays inline. `changed` means the list is
 * stale and must be refreshed (after the dialog closes, so the row's dialog is not torn down under it).
 */
export type ForgetOutcome = {
  message: string
  tone: "ok" | "warn" | "error"
  complete: boolean
  changed: boolean
  forgot: number
  skipped: number
}

export function forgetOutcome(requested: string[], result: ForgetResult | undefined): ForgetOutcome {
  const skipped = result?.skipped?.length ?? 0
  const forgot = Array.isArray(result?.observationIds) ? result.observationIds.length : Math.max(0, requested.length - skipped)
  const head = skipped ? `Forgot ${forgot}, skipped ${skipped} (not in this scope).` : forgot === 1 ? "Forgotten." : `Forgot ${plural(forgot, "memory", "memories")}.`
  const parts = [head]
  const reactivated = result?.reactivated?.length ?? 0
  if (reactivated) parts.push(`${plural(reactivated, "source memory", "source memories")} restored.`)
  const scrubbed = count(result?.backupsScrubbed)
  const failedBackups = count(result?.backupsFailed)
  if (scrubbed) parts.push(`${plural(scrubbed, "old backup", "old backups")} cleaned.`)
  if (failedBackups) parts.push(`${plural(failedBackups, "old backup", "old backups")} could not be cleaned yet; cleanup will retry.`)
  else if (result?.scrubPending) parts.push("Old backups are still being cleaned.")
  return {
    message: parts.join(" "),
    tone: skipped || failedBackups ? "warn" : "ok",
    complete: skipped === 0,
    changed: forgot > 0,
    forgot,
    skipped,
  }
}

/** A rejected forget. 404 means nothing matched any more (e.g. already forgotten from another window). */
export function forgetFailure(error: unknown): ForgetOutcome {
  if (error instanceof ApiError && error.status === 404) {
    return {
      message: "Nothing was forgotten: this memory is already gone (it may have been forgotten from another window). Close to refresh the list.",
      tone: "warn",
      complete: false,
      changed: true,
      forgot: 0,
      skipped: 0,
    }
  }
  const msg = error instanceof Error ? error.message : String(error)
  return { message: `Forget failed: ${msg}`, tone: "error", complete: false, changed: false, forgot: 0, skipped: 0 }
}
