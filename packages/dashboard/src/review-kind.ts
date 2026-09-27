/**
 * Core lists review rows with the review's own kind in `review_kind`; `kind` is overwritten by the
 * linked observation's kind (null for vault conflicts, which link to a topic). Older servers only send `kind`.
 */
export type ReviewKindFields = { kind?: string | null; review_kind?: string | null; data?: unknown }

export function reviewKind(item: ReviewKindFields): string | undefined {
  if (typeof item.review_kind === "string" && item.review_kind) return item.review_kind
  return item.kind || undefined
}

export function isVaultConflict(item: ReviewKindFields): boolean {
  return reviewKind(item) === "vault-conflict"
}

/** Only observation reviews accept edited content; promotions, reverts and vault conflicts ignore it. */
export function canEditReview(item: ReviewKindFields): boolean {
  if (isVaultConflict(item)) return false
  return !item.review_kind || item.review_kind === "observation"
}

export function reviewLabel(item: ReviewKindFields): string {
  if (isVaultConflict(item)) return "vault conflict"
  const rk = item.review_kind || undefined
  if (rk === "promotion") return item.kind ? `promotion · ${item.kind}` : "promotion"
  if (rk === "source-reverted") return item.kind ? `source reverted · ${item.kind}` : "source reverted"
  return item.kind || rk || "review"
}

/** Body text for a review row; vault conflicts have no observation content, so name the file instead. */
export function reviewText(item: ReviewKindFields & { content?: string | null; reason: string }): string {
  if (item.content) return item.content
  const path = isVaultConflict(item) ? vaultConflictPath(item) : undefined
  return path ? `${item.reason} (${path})` : item.reason
}

/** The vault file a conflict is about, from the review's `data` (JSON text or an object). */
export function vaultConflictPath(item: ReviewKindFields): string | undefined {
  let data = item.data
  if (typeof data === "string") {
    try {
      data = JSON.parse(data)
    } catch {
      return undefined
    }
  }
  const path = data && typeof data === "object" ? (data as { path?: unknown }).path : undefined
  return typeof path === "string" && path ? path : undefined
}
