import { describe, expect, test } from "bun:test"
import { pickSanitizedSvg, SVG_NS, type SvgElementLike, type SvgRootLike } from "../src/svg-xml"

// DOMPurify needs a real DOM, which bun does not provide (and no DOM shim is installed), so these
// tests cover the decision made on DOMPurify's output rather than DOMPurify's parsing itself.

function el(attrs: Record<string, string> = {}, namespaceURI: string | null = SVG_NS): SvgElementLike & { attrs: Record<string, string> } {
  return {
    attrs,
    namespaceURI,
    getAttribute: (n) => attrs[n] ?? null,
    setAttribute: (n, v) => {
      attrs[n] = v
    },
  }
}

function root(found: SvgElementLike | null): SvgRootLike {
  return { querySelector: (s) => (s === "svg" ? found : null) }
}

const serialize = (e: SvgElementLike) => `<svg xmlns="${e.getAttribute("xmlns")}"/>`

describe("pickSanitizedSvg", () => {
  test("returns empty string when no <svg> survived sanitization (never the raw input)", () => {
    expect(pickSanitizedSvg(root(null), serialize)).toBe("")
  })

  test("returns empty string for a missing or non-queryable root", () => {
    expect(pickSanitizedSvg(null, serialize)).toBe("")
    expect(pickSanitizedSvg(undefined, serialize)).toBe("")
    expect(pickSanitizedSvg("<svg onload=alert(1)>" as unknown as SvgRootLike, serialize)).toBe("")
  })

  test("rejects an element named svg outside the SVG namespace", () => {
    expect(pickSanitizedSvg(root(el({}, "http://www.w3.org/1999/xhtml")), serialize)).toBe("")
  })

  test("adds xmlns when missing and serializes the surviving svg", () => {
    const svg = el()
    expect(pickSanitizedSvg(root(svg), serialize)).toBe(`<svg xmlns="${SVG_NS}"/>`)
    expect(svg.attrs.xmlns).toBe(SVG_NS)
  })

  test("keeps an existing xmlns", () => {
    const svg = el({ xmlns: SVG_NS, width: "1" })
    pickSanitizedSvg(root(svg), serialize)
    expect(svg.attrs).toEqual({ xmlns: SVG_NS, width: "1" })
  })
})
