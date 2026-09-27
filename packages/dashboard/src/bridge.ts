import type { EmbedToHost, ServedConfig } from "../../core/src/contract"
import type { HostContext, MemoryState } from "./types"
import { readServedConfig } from "./api"
import { isTrustedHostEvent, parseOmContext } from "./bridge-parse"

function params(): URLSearchParams {
  return new URLSearchParams(location.search)
}

function allowedOrigin(candidate: string | null | undefined, config: ServedConfig | undefined): string | undefined {
  if (!candidate) return undefined
  const list = config?.allowedOrigins ?? []
  return list.includes(candidate) ? candidate : undefined
}

export function discoverHostOrigin(config = readServedConfig()): string | undefined {
  const fromAncestor = typeof location.ancestorOrigins !== "undefined" ? location.ancestorOrigins[0] : undefined
  const fromQuery = params().get("hostOrigin")
  return allowedOrigin(fromAncestor, config) ?? allowedOrigin(fromQuery, config)
}

export function initialHostContext(): HostContext {
  const q = params()
  const themeRaw = q.get("theme")
  const theme = themeRaw === "light" || themeRaw === "dark" ? themeRaw : undefined
  return {
    sessionID: q.get("session") ?? "",
    directory: q.get("directory") ?? "",
    theme,
    locale: q.get("locale") ?? "",
  }
}

export function applyTheme(theme: "light" | "dark" | undefined) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const dark = theme === "dark" || (theme !== "light" && prefersDark)
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
}

export function createBridge(opts: {
  onContext: (ctx: HostContext) => void
  getContext: () => HostContext
}) {
  const hostOrigin = discoverHostOrigin()
  const embedded = !!hostOrigin && window.parent !== window

  const post = (msg: EmbedToHost) => {
    if (!embedded || !hostOrigin) return
    window.parent.postMessage(msg, hostOrigin)
  }

  const ready = () => {
    if (embedded) post({ source: "opencode-memory", v: 1, type: "om:ready" })
  }

  const onMessage = (event: MessageEvent) => {
    if (!embedded || !hostOrigin) return
    if (!isTrustedHostEvent(event, hostOrigin, window.parent)) return
    const ctx = parseOmContext(event.data)
    if (!ctx) return
    opts.onContext(ctx)
  }

  window.addEventListener("message", onMessage)
  ready()

  return {
    hostOrigin,
    embedded,
    ready,
    destroy() {
      window.removeEventListener("message", onMessage)
    },
    navigate(sessionID: string, messageID: string) {
      post({ source: "opencode-memory", v: 1, type: "om:navigate", sessionID, messageID })
    },
    insert(text: string) {
      post({ source: "opencode-memory", v: 1, type: "om:insert", text })
    },
    status(state: MemoryState, reviewCount: number) {
      post({ source: "opencode-memory", v: 1, type: "om:status", state, reviewCount })
    },
    openDashboard(path?: string) {
      if (embedded) {
        post({ source: "opencode-memory", v: 1, type: "om:open-dashboard", path })
        return
      }
      const dest = path?.startsWith("/app") ? path : `/app${path ? (path.startsWith("/") ? path : `/${path}`) : ""}`
      window.open(dest + location.search, "_blank", "noopener")
    },
  }
}

export type MemoryBridge = ReturnType<typeof createBridge>
