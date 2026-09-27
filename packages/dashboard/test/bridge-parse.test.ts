import { describe, expect, test } from "bun:test"
import { isTrustedHostEvent, parseOmContext } from "../src/bridge-parse"

describe("parseOmContext", () => {
  test("treats om:context as a full snapshot with type checks", () => {
    expect(
      parseOmContext({
        source: "opencode-memory-host",
        v: 1,
        type: "om:context",
        sessionID: "s1",
        directory: "/proj",
        theme: "dark",
        locale: "en",
      }),
    ).toEqual({ sessionID: "s1", directory: "/proj", theme: "dark", locale: "en" })
  })

  test("missing or non-string fields become empty strings", () => {
    expect(
      parseOmContext({
        source: "opencode-memory-host",
        v: 1,
        type: "om:context",
        theme: "light",
      }),
    ).toEqual({ sessionID: "", directory: "", theme: "light", locale: "" })
    expect(
      parseOmContext({
        source: "opencode-memory-host",
        v: 1,
        type: "om:context",
        sessionID: 12,
        directory: null,
        theme: "sepia",
        locale: false,
      }),
    ).toEqual({ sessionID: "", directory: "", theme: undefined, locale: "" })
  })

  test("rejects other message types and sources", () => {
    expect(parseOmContext({ source: "opencode-memory", v: 1, type: "om:context" })).toBeUndefined()
    expect(parseOmContext({ source: "opencode-memory-host", v: 1, type: "om:ready" })).toBeUndefined()
    expect(parseOmContext({ source: "opencode-memory-host", v: 2, type: "om:context" })).toBeUndefined()
    expect(parseOmContext(null)).toBeUndefined()
  })
})

describe("isTrustedHostEvent", () => {
  const parent = { name: "parent" }
  test("accepts matching source and origin", () => {
    expect(isTrustedHostEvent({ source: parent, origin: "oc://renderer", data: {} }, "oc://renderer", parent)).toBe(true)
  })
  test("rejects origin or source mismatch", () => {
    expect(isTrustedHostEvent({ source: parent, origin: "https://evil.example", data: {} }, "oc://renderer", parent)).toBe(false)
    expect(isTrustedHostEvent({ source: {}, origin: "oc://renderer", data: {} }, "oc://renderer", parent)).toBe(false)
  })
})
