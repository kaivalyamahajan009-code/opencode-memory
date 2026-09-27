import { describe, expect, test } from "bun:test"
import { ApiError } from "../src/api-unwrap"
import { bulkSummary, runBulk } from "../src/review-bulk"

describe("runBulk", () => {
  test("continues past failures and separates already-resolved items", async () => {
    const seen: string[] = []
    const r = await runBulk(["a", "b", "c", "d"], async (id) => {
      seen.push(id)
      if (id === "b") throw new ApiError("already resolved", 409)
      if (id === "c") throw new ApiError("boom", 500)
    })
    expect(seen).toEqual(["a", "b", "c", "d"])
    expect(r).toEqual({ done: ["a", "d"], already: ["b"], failed: [{ id: "c", error: "boom" }] })
    expect(bulkSummary("approve", r)).toBe("Approved 2, 1 already resolved, 1 failed (boom)")
  })

  test("summary for a clean run", async () => {
    const r = await runBulk(["a"], async () => undefined)
    expect(bulkSummary("reject", r)).toBe("Rejected 1")
  })
})
