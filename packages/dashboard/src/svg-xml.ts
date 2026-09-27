export const SVG_NS = "http://www.w3.org/2000/svg"

export type SvgElementLike = {
  namespaceURI?: string | null
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
}

export type SvgRootLike = { querySelector(selector: string): SvgElementLike | null }

/**
 * Serializes the first SVG-namespace <svg> left in the sanitized tree. Returns "" when none
 * survived; callers must never fall back to the unsanitized input.
 */
export function pickSanitizedSvg(root: SvgRootLike | null | undefined, serialize: (el: SvgElementLike) => string): string {
  const svg = typeof root?.querySelector === "function" ? root.querySelector("svg") : null
  if (!svg) return ""
  if (svg.namespaceURI != null && svg.namespaceURI !== SVG_NS) return ""
  if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", SVG_NS)
  return serialize(svg)
}
