import { describe, expect, test } from "bun:test"
import { bulkableIds } from "../src/review-bulk"
import { canEditReview, isVaultConflict, reviewKind, reviewLabel, reviewText, vaultConflictPath } from "../src/review-kind"
import type { ReviewItem } from "../src/types"

/** Rows as core's listReviewItems returns them: `r.kind AS review_kind`, then `o.kind` overwrites `kind`. */
const vaultRow: ReviewItem = {
  id: "rev_vault",
  kind: null,
  review_kind: "vault-conflict",
  ref_id: "top_rec",
  reason: "the topic file was edited outside opencode-memory",
  state: "open",
  data: JSON.stringify({ path: "concepts/recursion.md", generation: 2 }),
  created_at: 1,
  content: null,
  confidence: null,
  evidence_type: null,
  scope_kind: null,
  status: null,
  visibility: null,
}

const observationRow: ReviewItem = {
  id: "rev_obs",
  kind: "demonstrated-skill",
  review_kind: "observation",
  ref_id: "obs_mastery",
  reason: "mastery claims require human review",
  state: "open",
  created_at: 2,
  content: "Mastered recursion",
  confidence: 0.7,
  evidence_type: "inferred",
  status: "pending_review",
  visibility: "visible",
}

const promotionRow: ReviewItem = { ...observationRow, id: "rev_promo", review_kind: "promotion", kind: "preference", status: "active" }

describe("review kind with the real row shape", () => {
  test("a vault conflict is recognised from review_kind even though kind is null", () => {
    expect(reviewKind(vaultRow)).toBe("vault-conflict")
    expect(isVaultConflict(vaultRow)).toBe(true)
    expect(isVaultConflict(observationRow)).toBe(false)
    expect(isVaultConflict(promotionRow)).toBe(false)
  })

  test("review_kind wins over the observation's kind", () => {
    expect(isVaultConflict({ kind: "vault-conflict", review_kind: "observation" })).toBe(false)
  })

  test("older servers that only send kind still work", () => {
    expect(isVaultConflict({ kind: "vault-conflict" })).toBe(true)
    expect(isVaultConflict({ kind: "fact" })).toBe(false)
    expect(isVaultConflict({})).toBe(false)
  })

  test("labels name the review kind; only observation reviews are editable", () => {
    expect(reviewLabel(vaultRow)).toBe("vault conflict")
    expect(reviewLabel(observationRow)).toBe("demonstrated-skill")
    expect(reviewLabel(promotionRow)).toBe("promotion · preference")
    expect(reviewLabel({ review_kind: "source-reverted", kind: null })).toBe("source reverted")
    expect(canEditReview(observationRow)).toBe(true)
    expect(canEditReview({ kind: "fact" })).toBe(true)
    expect(canEditReview(vaultRow)).toBe(false)
    expect(canEditReview(promotionRow)).toBe(false)
  })

  test("vault conflicts show the reason and file instead of observation content", () => {
    expect(vaultConflictPath(vaultRow)).toBe("concepts/recursion.md")
    expect(vaultConflictPath({ data: { path: "a.md" } })).toBe("a.md")
    expect(vaultConflictPath({ data: "not json" })).toBeUndefined()
    expect(reviewText(vaultRow)).toBe("the topic file was edited outside opencode-memory (concepts/recursion.md)")
    expect(reviewText(observationRow)).toBe("Mastered recursion")
  })
})

describe("bulkableIds", () => {
  test("excludes real-shape vault conflicts even when picked", () => {
    const items = [vaultRow, observationRow, promotionRow]
    expect(bulkableIds(items, { rev_vault: true, rev_obs: true, rev_promo: true })).toEqual(["rev_obs", "rev_promo"])
    expect(bulkableIds(items, { rev_vault: true })).toEqual([])
    expect(bulkableIds(items, {})).toEqual([])
  })
})
