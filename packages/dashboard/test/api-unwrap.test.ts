import { describe, expect, test } from "bun:test"
import { unwrapEnvelope, unwrapNestedFailure } from "../src/api-unwrap"

describe("unwrapEnvelope", () => {
  test("unwraps ok:true data", () => {
    expect(unwrapEnvelope({ ok: true, data: { n: 3 } }, 200)).toEqual({ ok: true, data: { n: 3 } })
  })

  test("surfaces HTTP ok:false", () => {
    expect(unwrapEnvelope({ ok: false, error: "not found" }, 404)).toEqual({
      ok: false,
      error: "not found",
      status: 404,
    })
  })

  test("treats nested data.ok === false as failure", () => {
    expect(unwrapEnvelope({ ok: true, data: { ok: false, error: "supersede failed" } }, 200)).toEqual({
      ok: false,
      error: "supersede failed",
      status: 400,
    })
  })

  test("treats nested done === false as failure", () => {
    expect(unwrapEnvelope({ ok: true, data: { done: false } }, 200)).toEqual({
      ok: false,
      error: "not found or already resolved",
      status: 409,
    })
  })

  test("done:true is success", () => {
    expect(unwrapEnvelope({ ok: true, data: { done: true } }, 200)).toEqual({ ok: true, data: { done: true } })
  })
})

describe("unwrapNestedFailure", () => {
  test("ignores non-objects", () => {
    expect(unwrapNestedFailure("x")).toEqual({ ok: true })
    expect(unwrapNestedFailure(null)).toEqual({ ok: true })
  })
})
