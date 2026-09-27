import DOMPurify from "dompurify"
import { pickSanitizedSvg, type SvgRootLike } from "./svg-xml"

const EVENT_ATTRS = [
  "onload",
  "onerror",
  "onclick",
  "onmouseover",
  "onmouseenter",
  "onmouseleave",
  "onfocus",
  "onblur",
  "onbegin",
  "onend",
  "onrepeat",
  "onchange",
  "oninput",
  "onkeydown",
  "onkeyup",
  "onmousedown",
  "onmouseup",
  "ontouchstart",
  "onactivate",
  "onanimationstart",
  "onanimationend",
]

/** Returns "" when nothing renderable survives sanitization; never returns the raw input. */
export function sanitizeSvg(raw: string): string {
  const root = DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "script", "iframe", "object", "embed", "link", "meta"],
    FORBID_ATTR: EVENT_ATTRS,
    RETURN_DOM: true,
  }) as unknown as SvgRootLike | null
  return pickSanitizedSvg(root, (el) => new XMLSerializer().serializeToString(el as unknown as Node))
}

export const UNSUPPORTED_SVG = "Unsupported SVG: nothing renderable survived sanitization"

export function svgBlobUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))
}
