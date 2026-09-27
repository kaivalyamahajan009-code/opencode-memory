import type { HostContext } from "./types"

export function parseOmContext(data: unknown): HostContext | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  if (d.source !== "opencode-memory-host") return undefined
  if (d.v !== 1) return undefined
  if (d.type !== "om:context") return undefined
  const theme = d.theme === "light" || d.theme === "dark" ? d.theme : undefined
  return {
    sessionID: typeof d.sessionID === "string" ? d.sessionID : "",
    directory: typeof d.directory === "string" ? d.directory : "",
    theme,
    locale: typeof d.locale === "string" ? d.locale : "",
  }
}

export function isTrustedHostEvent(event: {
  source: unknown
  origin: string
  data: unknown
}, hostOrigin: string, parent: unknown): boolean {
  return event.source === parent && event.origin === hostOrigin
}
