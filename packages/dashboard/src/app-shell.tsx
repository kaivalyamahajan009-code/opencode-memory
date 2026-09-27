import { For, Match, Show, Suspense, Switch, createSignal, lazy, onCleanup } from "solid-js"
import { DashboardProvider, useDash } from "./store"
import { ToastHost } from "./toast"
import { Banner, EmptyState, ViewBoundary } from "./ui"
import { applyTheme } from "./bridge"
import { PauseReasonBanner } from "./widgets"

const Overview = lazy(() => import("./views/overview"))
const Timeline = lazy(() => import("./views/timeline"))
const Search = lazy(() => import("./views/search"))
const Knowledge = lazy(() => import("./views/knowledge"))
const Learning = lazy(() => import("./views/learning"))
const Research = lazy(() => import("./views/research"))
const Artifacts = lazy(() => import("./views/artifacts"))
const Review = lazy(() => import("./views/review"))
const Runs = lazy(() => import("./views/runs"))
const Settings = lazy(() => import("./views/settings"))

const NAV: { id: string; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "search", label: "Search" },
  { id: "knowledge", label: "Knowledge" },
  { id: "learning", label: "Learning" },
  { id: "research", label: "Research" },
  { id: "artifacts", label: "Artifacts" },
  { id: "review", label: "Review" },
  { id: "runs", label: "Runs" },
  { id: "settings", label: "Settings" },
]

function parseView(): string {
  const rest = location.pathname.replace(/^\/app\/?/, "")
  const id = rest.split("/")[0]
  return NAV.some((n) => n.id === id) ? id : "overview"
}

function ShellInner() {
  const dash = useDash()
  const [view, setView] = createSignal(parseView())
  const onPop = () => setView(parseView())
  window.addEventListener("popstate", onPop)
  onCleanup(() => window.removeEventListener("popstate", onPop))

  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const onScheme = () => {
    if (!dash.host().theme) applyTheme(undefined)
  }
  media.addEventListener("change", onScheme)
  onCleanup(() => media.removeEventListener("change", onScheme))

  const go = (id: string) => {
    const u = new URL(location.href)
    u.pathname = `/app/${id}`
    history.pushState(null, "", u.pathname + u.search)
    setView(id)
  }

  const err = () => dash.error()
  const hasData = () => !!dash.status()
  const fatal = () => {
    if (hasData()) return false
    const e = err()
    return !!e
  }
  const fatalTitle = () => {
    const e = err()
    if (e?.status === 401) return "Unauthorized"
    if (e?.status === 0) return "Memory API unreachable"
    return "Something went wrong"
  }
  const banner = () => {
    const e = err()
    if (!e || !hasData()) return ""
    if (e.status === 401) return "Unauthorized — token missing or invalid."
    if (e.status === 0) return "Memory API unreachable. Showing last data."
    return e.message
  }

  return (
    <div class="flex h-full min-h-0 bg-[var(--om-bg)] text-[var(--om-fg)]">
      <nav class="flex w-[9.5rem] shrink-0 flex-col border-r border-neutral-200 py-2 dark:border-neutral-800" aria-label="Dashboard">
        <p class="px-3 pb-2 text-[13px] font-semibold">Memory</p>
        <For each={NAV}>
          {(n) => (
            <button
              type="button"
              class={`px-3 py-1 text-left ${view() === n.id ? "bg-neutral-200 font-medium dark:bg-neutral-800" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"}`}
              aria-current={view() === n.id ? "page" : undefined}
              onClick={() => go(n.id)}
            >
              {n.label}
            </button>
          )}
        </For>
        <label class="mt-auto px-3 py-2 text-[11px] text-neutral-500">
          Workspace
          <select
            class="mt-1 w-full rounded border border-neutral-300 bg-white px-1 py-0.5 text-[12px] text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            value={dash.workspace()}
            aria-label="Workspace"
            onChange={(e) => dash.setWorkspace(e.currentTarget.value)}
          >
            <option value="">All workspaces</option>
            <For each={dash.workspaces()}>{(w) => <option value={w}>{w}</option>}</For>
          </select>
        </label>
      </nav>
      <main class="min-w-0 flex-1 overflow-auto">
        <Show when={banner()}>
          <Banner>{banner()}</Banner>
        </Show>
        <PauseReasonBanner global={dash.status()?.global} onResume={() => void dash.pause()} />
        <Show
          when={!fatal()}
          fallback={
            <EmptyState
              title={fatalTitle()}
              body={err()?.status === 401 ? "The dashboard token is missing or invalid." : err()?.message}
            />
          }
        >
          <Suspense fallback={<p class="p-4 text-neutral-500">Loading…</p>}>
            <Switch>
              <Match when={view() === "overview"}>
                <ViewBoundary>
                  <Overview />
                </ViewBoundary>
              </Match>
              <Match when={view() === "timeline"}>
                <ViewBoundary>
                  <Timeline />
                </ViewBoundary>
              </Match>
              <Match when={view() === "search"}>
                <ViewBoundary>
                  <Search />
                </ViewBoundary>
              </Match>
              <Match when={view() === "knowledge"}>
                <ViewBoundary>
                  <Knowledge />
                </ViewBoundary>
              </Match>
              <Match when={view() === "learning"}>
                <ViewBoundary>
                  <Learning />
                </ViewBoundary>
              </Match>
              <Match when={view() === "research"}>
                <ViewBoundary>
                  <Research />
                </ViewBoundary>
              </Match>
              <Match when={view() === "artifacts"}>
                <ViewBoundary>
                  <Artifacts />
                </ViewBoundary>
              </Match>
              <Match when={view() === "review"}>
                <ViewBoundary>
                  <Review />
                </ViewBoundary>
              </Match>
              <Match when={view() === "runs"}>
                <ViewBoundary>
                  <Runs />
                </ViewBoundary>
              </Match>
              <Match when={view() === "settings"}>
                <ViewBoundary>
                  <Settings />
                </ViewBoundary>
              </Match>
            </Switch>
          </Suspense>
        </Show>
      </main>
      <ToastHost items={dash.toasts.items()} />
    </div>
  )
}

export function AppShell() {
  return (
    <DashboardProvider>
      <ShellInner />
    </DashboardProvider>
  )
}
