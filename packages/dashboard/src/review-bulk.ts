import { isVaultConflict, type ReviewKindFields } from "./review-kind"

export type BulkResult = { done: string[]; already: string[]; failed: { id: string; error: string }[] }

/** Picked ids that may be bulk-decided; vault conflicts always need their own confirmed decision. */
export function bulkableIds(items: (ReviewKindFields & { id: string })[], picked: Record<string, boolean>): string[] {
  return items.filter((it) => picked[it.id] && !isVaultConflict(it)).map((it) => it.id)
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status
  return typeof s === "number" ? s : undefined
}

/** Runs every item even when some fail; 409 (already resolved) is reported separately. */
export async function runBulk(ids: string[], act: (id: string) => Promise<unknown>): Promise<BulkResult> {
  const out: BulkResult = { done: [], already: [], failed: [] }
  for (const id of ids) {
    try {
      await act(id)
      out.done.push(id)
    } catch (e) {
      if (statusOf(e) === 409) out.already.push(id)
      else out.failed.push({ id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

export function bulkSummary(decision: "approve" | "reject", r: BulkResult): string {
  const verb = decision === "approve" ? "Approved" : "Rejected"
  const parts = [`${verb} ${r.done.length}`]
  if (r.already.length) parts.push(`${r.already.length} already resolved`)
  if (r.failed.length) parts.push(`${r.failed.length} failed (${r.failed[0].error})`)
  return parts.join(", ")
}
