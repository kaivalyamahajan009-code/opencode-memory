import { describe, expect, test } from "bun:test"
import { ApiError } from "../src/api-unwrap"
import {
  forgetBody,
  forgetCandidatesBody,
  forgetFailure,
  forgetOutcome,
  forgetRequest,
  forgetSelection,
  purgeLabel,
  PURGE_SOURCES_DEFAULT,
} from "../src/forget-select"

describe("forgetSelection", () => {
  test("includes only the row plus ticked ids", () => {
    expect(forgetSelection("row-1", [])).toEqual(["row-1"])
    expect(forgetSelection("row-1", ["a", "b"])).toEqual(["row-1", "a", "b"])
  })

  test("does not duplicate the row if it was ticked", () => {
    expect(forgetSelection("row-1", ["row-1", "a"])).toEqual(["row-1", "a"])
  })

  test("drops empty ids", () => {
    expect(forgetSelection("row-1", ["", "a"])).toEqual(["row-1", "a"])
  })
})

describe("forgetRequest", () => {
  test("defaults to keeping sources (purgeSources 'none')", () => {
    expect(PURGE_SOURCES_DEFAULT).toBe(false)
    expect(forgetRequest("row-1", [])).toEqual({ ids: ["row-1"], purgeSources: "none" })
  })

  test("purges only when explicitly asked, for every selected id", () => {
    expect(forgetRequest("row-1", ["a"], true)).toEqual({ ids: ["row-1", "a"], purgeSources: "sources" })
    expect(forgetRequest("row-1", ["a"], false)).toEqual({ ids: ["row-1", "a"], purgeSources: "none" })
  })

  test("purge label names how many memories it applies to", () => {
    expect(purgeLabel(1)).toBe("Also delete the cited conversation parts for the 1 selected memory (other memories may rely on them)")
    expect(purgeLabel(3)).toContain("for the 3 selected memories")
  })
})

describe("forget request bodies", () => {
  test("a user forget never names a session or project, so the server runs a global forget", () => {
    const body = forgetBody(forgetRequest("row-1", ["a"], true))
    expect(body).toEqual({ ids: ["row-1", "a"], confirm: true, reason: "dashboard forget", purgeSources: "sources" })
    expect("session" in body).toBe(false)
    expect("project" in body).toBe(false)
  })

  test("candidate lookups carry only the text", () => {
    expect(forgetCandidatesBody("dark mode")).toEqual({ text: "dark mode" })
  })
})

describe("forgetOutcome", () => {
  const base = { partsPurged: 0, topicsTouched: [], snapshotsPurged: 0 }

  test("full success", () => {
    expect(forgetOutcome(["a", "b"], { ...base, observationIds: ["a", "b"] })).toEqual({
      message: "Forgot 2 memories.",
      tone: "ok",
      complete: true,
      changed: true,
      forgot: 2,
      skipped: 0,
    })
    expect(forgetOutcome(["a"], { ...base, observationIds: ["a"] }).message).toBe("Forgotten.")
  })

  test("a pending backup scrub is reported without making the forget partial", () => {
    const o = forgetOutcome(["a"], { ...base, observationIds: ["a"], skipped: [], scrubPending: true })
    expect(o.message).toBe("Forgotten. Old backups are still being cleaned.")
    expect(o.complete).toBe(true)
    expect(o.tone).toBe("ok")
  })

  test("restored sources of a forgotten summary are counted", () => {
    const o = forgetOutcome(["sum"], { ...base, observationIds: ["sum"], reactivated: ["s1", "s2"], scrubPending: false })
    expect(o.message).toBe("Forgotten. 2 source memories restored.")
    expect(forgetOutcome(["sum"], { ...base, observationIds: ["sum"], reactivated: ["s1"] }).message).toContain("1 source memory restored.")
  })

  test("awaited scrub counts use core's backupsScrubbed / backupsFailed", () => {
    const o = forgetOutcome(["a"], { ...base, observationIds: ["a"], backupsScrubbed: 2, backupsFailed: 1, scrubPending: true })
    expect(o.message).toBe("Forgotten. 2 old backups cleaned. 1 old backup could not be cleaned yet; cleanup will retry.")
    expect(o.tone).toBe("warn")
    expect(o.complete).toBe(true)
  })

  test("skipped ids are reported and the outcome is not a full success", () => {
    const o = forgetOutcome(["a", "b"], { ...base, observationIds: ["a"], skipped: ["b"] })
    expect(o.message).toBe("Forgot 1, skipped 1 (not in this scope).")
    expect(o.complete).toBe(false)
    expect(o.changed).toBe(true)
  })

  test("falls back to requested minus skipped when observationIds is missing", () => {
    const o = forgetOutcome(["a", "b", "c"], { skipped: ["c"] } as never)
    expect(o.forgot).toBe(2)
    expect(o.message).toBe("Forgot 2, skipped 1 (not in this scope).")
  })
})

describe("forgetFailure", () => {
  test("404 (every id already gone or skipped) is a clear notice that still refreshes the list", () => {
    const o = forgetFailure(new ApiError("not found", 404))
    expect(o.tone).toBe("warn")
    expect(o.changed).toBe(true)
    expect(o.complete).toBe(false)
    expect(o.message).toContain("Nothing was forgotten")
  })

  test("other errors are errors and leave the list alone", () => {
    const o = forgetFailure(new ApiError("destructive action requires confirm: true", 400))
    expect(o).toMatchObject({ tone: "error", changed: false, message: "Forget failed: destructive action requires confirm: true" })
    expect(forgetFailure(new Error("Memory API unreachable")).tone).toBe("error")
  })
})
