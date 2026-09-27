import { describe, expect, test } from "bun:test"
import { ApiError } from "../src/api-unwrap"
import { createConfigState } from "../src/config-state"
import {
  FORGOTTEN_SESSION_TEXT,
  INSTRUCTION_REFUSED_TEXT,
  isChunkLoadError,
  restoreErrorText,
  sessionFlagErrorText,
  writeErrorText,
} from "../src/errors"
import { createFreshness } from "../src/freshness"
import { DEFAULT_LEARNING_WORKSPACE, learningWorkspace } from "../src/learning-scope"

describe("createConfigState", () => {
  test("a GET that fails after a successful save does not set configError", () => {
    const s = createConfigState<{ v: number }>()
    const gen = s.begin()
    s.apply({ v: 2 })
    s.reject(gen, new Error("HTTP 500"))
    expect(s.get()).toEqual({ value: { v: 2 }, error: undefined, loaded: true })
  })

  test("a GET that succeeds after a save does not replace the saved value", () => {
    const s = createConfigState<{ v: number }>()
    const gen = s.begin()
    s.apply({ v: 2 })
    s.resolve(gen, { v: 1 })
    expect(s.get().value).toEqual({ v: 2 })
  })

  test("current GETs report errors and clear them on the next success", () => {
    const s = createConfigState<{ v: number }>()
    s.reject(s.begin(), new Error("unreachable"))
    expect(s.get()).toEqual({ value: undefined, error: "unreachable", loaded: false })
    s.resolve(s.begin(), { v: 1 })
    expect(s.get()).toEqual({ value: { v: 1 }, error: undefined, loaded: true })
  })
})

describe("createFreshness", () => {
  test("fresh values are reused until they age out", () => {
    const f = createFreshness(9000)
    expect(f.want(0)).toBe(true)
    f.store(f.begin(), 1000)
    expect(f.want(5000)).toBe(false)
    expect(f.want(10_001)).toBe(true)
  })

  test("invalidate forces a refetch however young the value is", () => {
    const f = createFreshness(9000)
    f.store(f.begin(), 1000)
    f.invalidate()
    expect(f.want(1001)).toBe(true)
  })

  test("a fetch that started before invalidate() stores a stale value", () => {
    const f = createFreshness(9000)
    const startedAt = f.begin()
    f.invalidate()
    f.store(startedAt, 2000)
    expect(f.want(2001)).toBe(true)
    f.store(f.begin(), 2100)
    expect(f.want(2200)).toBe(false)
  })
})

describe("isChunkLoadError", () => {
  test("recognises dynamic-import failures across browsers", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1:4747/assets/timeline-abc.js"))).toBe(true)
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true)
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true)
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/index.css"))).toBe(true)
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true)
  })

  test("ordinary errors keep the Retry path", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe("restoreErrorText", () => {
  test("shows the server's refusal as-is", () => {
    expect(restoreErrorText(new ApiError("refusing to restore: the file has no backup marker", 400))).toBe(
      "Restore failed: refusing to restore: the file has no backup marker",
    )
  })

  test("points at the log for server errors", () => {
    expect(restoreErrorText(new ApiError("internal error", 500))).toBe("Restore failed: internal error. Check the OpenCode log for details.")
  })

  test("keeps the 409/400 split core uses for unmarked and empty backups", () => {
    expect(restoreErrorText(new ApiError("backup file is missing or empty", 400))).toBe("Restore failed: backup file is missing or empty")
    expect(restoreErrorText(new ApiError("refusing to restore: the backup has no sessions, observations or topics", 409))).toBe(
      "Restore failed: refusing to restore: the backup has no sessions, observations or topics",
    )
  })
})

describe("writeErrorText", () => {
  test("instruction-like content (400) gets the plain explanation", () => {
    const core = "instruction-like content is not stored from the agent (it could steer future sessions); the user can add it from the Memory dashboard"
    expect(writeErrorText(new ApiError(core, 400))).toBe(INSTRUCTION_REFUSED_TEXT)
    expect(INSTRUCTION_REFUSED_TEXT).toBe("Memories can't contain instructions to the assistant.")
  })

  test("forgotten, excluded and deleted sessions (409) say why nothing can be stored", () => {
    expect(writeErrorText(new ApiError("this session was forgotten; nothing more is stored from it", 409))).toBe(
      "This session was forgotten, so nothing more can be stored from it.",
    )
    expect(writeErrorText(new ApiError("this session is excluded from memory; memories cannot be written to it", 409))).toContain("excluded from memory")
    expect(writeErrorText(new ApiError("this session was deleted; memories cannot be written to it", 409))).toContain("deleted")
  })

  test("other refusals show the server's message as a sentence", () => {
    expect(writeErrorText(new ApiError("invalid payload hints: Too big", 400))).toBe("Invalid payload hints: Too big")
    expect(writeErrorText(new ApiError("this content was forgotten earlier and will not be stored again", 409))).toBe(
      "This content was forgotten earlier and will not be stored again",
    )
    expect(writeErrorText(new Error("network down"))).toBe("network down")
  })
})

describe("sessionFlagErrorText", () => {
  test("un-excluding a forgotten session (409) explains it cannot be re-included", () => {
    expect(sessionFlagErrorText(new ApiError("this session was forgotten and cannot be included in memory again", 409))).toBe(FORGOTTEN_SESSION_TEXT)
    expect(FORGOTTEN_SESSION_TEXT).toBe("This session was forgotten and can't be re-included.")
    expect(sessionFlagErrorText(new ApiError("paused must be a boolean", 400))).toBe("Paused must be a boolean")
  })
})

describe("learningWorkspace", () => {
  test("'All workspaces' uses the server's default workspace for every learning query", () => {
    expect(learningWorkspace("")).toEqual({ workspace: DEFAULT_LEARNING_WORKSPACE, fallback: true })
    expect(learningWorkspace("learning")).toEqual({ workspace: "learning", fallback: false })
  })
})
