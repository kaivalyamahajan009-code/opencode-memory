import { describe, expect, test } from "bun:test"
import { buildObserverInput, collapseRepeats, detectDegenerate } from "../src/normalize"
import { stored } from "./helpers"

describe("repetitive and degenerate output", () => {
  test("collapseRepeats collapses runs of identical (or digit-normalized) lines", () => {
    const text = ["error: failed 1", "error: failed 2", "error: failed 3", "error: failed 4", "ok"].join("\n")
    const out = collapseRepeats(text)
    expect(out).toContain("error: failed 1")
    expect(out).toContain("[previous line pattern repeated 3 more times]")
    expect(out).toContain("ok")
    expect(out.split("\n").length).toBeLessThan(text.split("\n").length)
  })

  test("detectDegenerate flags a very long line and a low unique-line ratio", () => {
    expect(detectDegenerate("short")).toEqual({ degenerate: false })
    expect(detectDegenerate("x".repeat(20_001)).degenerate).toBe(true)
    const lines = Array.from({ length: 80 }, (_, i) => (i % 3 === 0 ? "aaaa" : i % 3 === 1 ? "bbbb" : "aaaa"))
    expect(detectDegenerate(lines.join("\n")).degenerate).toBe(true)
  })

  test("a huge repetitive tool output produces bounded observer input", () => {
    const repeated = Array.from({ length: 400 }, (_, i) => `status line ${i % 2 === 0 ? "alpha" : "beta"} retry=${i}`).join("\n")
    const { msg, part } = stored("a1", 1, "assistant", `tool=bash status=completed\ninput: {}\noutput:\n${repeated}`, { type: "tool", tool: "bash" })
    const input = buildObserverInput([msg], [part], { toolOutputMax: 400 })
    expect(input.tokens).toBeLessThan(2_000)
    expect(input.text.length).toBeLessThan(8_000)
    expect(input.messages[0].text.length).toBeLessThan(5_000)
  })

  test("alternating near-duplicate lines that survive collapse are still capped when degenerate", () => {
    const lines: string[] = []
    for (let i = 0; i < 60; i++) lines.push(i % 2 === 0 ? "the same noise pattern continues" : "the same noise pattern continues!")
    const { msg, part } = stored("a1", 1, "assistant", lines.join("\n"), { type: "tool", tool: "bash" })
    const input = buildObserverInput([msg], [part], { toolOutputMax: 8_000, perMessageMax: 12_000 })
    expect(input.messages[0].text.length).toBeLessThanOrEqual(2500)
  })
})
