import { createContext, useContext, type ParentProps } from "solid-js"
import { createResource, createSignal } from "solid-js"
import { fetchConfig, fetchProjects, fetchSessions, fetchStatus, fetchWorkspaces, setPaused } from "./api"
import { applyTheme, initialHostContext } from "./bridge"
import { createConfigState } from "./config-state"
import { createPoll } from "./poll"
import { createToasts } from "./toast"
import type { HostContext, MemoryConfigView, ProjectRow, SessionListItem, StatusPayload } from "./types"

export type DashCtx = {
  host: () => HostContext
  setHost: (ctx: HostContext) => void
  status: () => StatusPayload | undefined
  error: () => { message: string; status: number } | undefined
  loading: () => boolean
  reload: () => Promise<void>
  config: () => MemoryConfigView | undefined
  /** Replace the config baseline immediately, e.g. with the config POST /api/config returned. */
  applyConfig: (cfg: MemoryConfigView) => void
  configError: () => string | undefined
  configLoaded: () => boolean
  projects: () => ProjectRow[]
  sessions: () => SessionListItem[]
  workspaces: () => string[]
  workspace: () => string
  setWorkspace: (w: string) => void
  domain: () => string
  toasts: ReturnType<typeof createToasts>
  pause: () => Promise<void>
}

const Ctx = createContext<DashCtx>()

export function DashboardProvider(props: ParentProps) {
  const toasts = createToasts()
  const [host, setHost] = createSignal<HostContext>(initialHostContext())
  const [workspaceFilter, setWorkspaceFilter] = createSignal<string | undefined>(undefined)
  applyTheme(host().theme)

  const [wsList] = createResource(() => fetchWorkspaces().catch(() => [] as string[]))

  const configState = createConfigState<MemoryConfigView>()
  let cachedProjects: ProjectRow[] = []
  let lastSlow = 0

  const poll = createPoll({
    key: () => host().sessionID,
    fn: async () => {
      const session = host().sessionID || undefined
      const now = Date.now()
      if (now - lastSlow > 60_000 || !cachedProjects.length || !configState.get().loaded) {
        lastSlow = now
        const gen = configState.begin()
        const [projects] = await Promise.all([
          fetchProjects().catch(() => cachedProjects),
          fetchConfig().then(
            (c) => configState.resolve(gen, c),
            (e) => configState.reject(gen, e),
          ),
        ])
        cachedProjects = projects
      }
      const [status, sessions] = await Promise.all([
        fetchStatus(session),
        fetchSessions(undefined, 100).catch(() => [] as SessionListItem[]),
      ])
      const cfg = configState.get()
      return {
        status,
        projects: cachedProjects,
        sessions,
        config: cfg.value,
        configError: cfg.error,
        configLoaded: cfg.loaded,
      }
    },
  })

  const inferredWorkspace = () => {
    const st = poll.data()?.status.session
    const p = poll.data()?.projects.find((x) => x.id === st?.projectId)
    const s = poll.data()?.sessions.find((x) => x.id === host().sessionID)
    return p?.workspace || s?.workspace || ""
  }

  const workspace = () => (workspaceFilter() !== undefined ? workspaceFilter()! : inferredWorkspace())

  const domain = () => {
    const st = poll.data()?.status.session
    return poll.data()?.projects.find((x) => x.id === st?.projectId)?.domain || "general"
  }

  const value: DashCtx = {
    host,
    setHost: (ctx) => {
      setHost(ctx)
      applyTheme(ctx.theme)
      const u = new URL(location.href)
      if (ctx.sessionID) u.searchParams.set("session", ctx.sessionID)
      else u.searchParams.delete("session")
      history.replaceState(null, "", u.pathname + u.search)
      void poll.reload()
    },
    status: () => poll.data()?.status,
    error: () => {
      const e = poll.error()
      return e ? { message: e.message, status: e.status } : undefined
    },
    loading: () => poll.loading(),
    reload: () => poll.reload(),
    config: () => poll.data()?.config,
    applyConfig: (cfg) => {
      configState.apply(cfg)
      poll.mutate((d) => (d ? { ...d, config: cfg, configError: undefined, configLoaded: true } : d))
    },
    configError: () => poll.data()?.configError,
    configLoaded: () => !!poll.data()?.configLoaded,
    projects: () => poll.data()?.projects ?? [],
    sessions: () => poll.data()?.sessions ?? [],
    workspaces: () => {
      const listed = wsList.latest ?? []
      const extra = inferredWorkspace()
      if (extra && !listed.includes(extra)) return [extra, ...listed]
      return listed
    },
    workspace,
    setWorkspace: (w) => setWorkspaceFilter(w),
    domain,
    toasts,
    pause: async () => {
      try {
        await setPaused(!(poll.data()?.status.global.paused ?? false))
        await poll.reload()
      } catch (e) {
        toasts.error(e instanceof Error ? e.message : String(e))
      }
    },
  }

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

export function useDash(): DashCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error("DashboardProvider missing")
  return v
}
