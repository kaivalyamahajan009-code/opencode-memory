import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  fetchCommand,
  fetchConfig,
  fetchContext,
  fetchLearning,
  fetchObservation,
  fetchProjects,
  fetchResearch,
  fetchReview,
  fetchSearch,
  fetchStatus,
  fetchTimeline,
  flushSession,
  setPaused,
  unwrapHits,
} from "./api"
import { applyTheme, createBridge, initialHostContext, type MemoryBridge } from "./bridge"
import { commandOutcome, flushErrorText, flushStartMessage, parseFlushResponse, pollCommand } from "./commands"
import { errorMessage } from "./errors"
import { formatDay } from "./format"
import { createFreshness, type Freshness } from "./freshness"
import { createPoll } from "./poll"
import { deriveMemoryState, statusTitle } from "./status"
import { createToasts, ToastHost } from "./toast"
import type {
  ClaimRow,
  ContextPayload,
  DueReview,
  HostContext,
  LearningPayload,
  MemoryConfigView,
  ObservationRow,
  ObservationSource,
  ProjectRow,
  RecallResult,
  ResearchPayload,
  ReviewItem,
  SearchHit,
  StatusPayload,
  TimelinePayload,
} from "./types"
import { EVIDENCE_TYPES, KINDS } from "./types"
import { Banner, Button, EmptyState, Menu, MenuItem, Select, ViewBoundary } from "./ui"
import {
  DomainCards,
  InContextNow,
  MemoryGauges,
  ObservationCard,
  PauseReasonBanner,
  RememberDialog,
  ReviewList,
  ScopeChips,
  SearchPanel,
  StatusPill,
  loadRecall,
  matchesScope,
} from "./widgets"

type Bundle = {
  status: StatusPayload
  review: ReviewItem[]
  context?: ContextPayload
  timeline?: TimelinePayload
  learning?: LearningPayload
  research?: ResearchPayload
  projects: ProjectRow[]
  config?: MemoryConfigView
}

/** Last good per-session data, used when a refresh fails or is skipped. Replaced on session change. */
type SessionCache = {
  session: string
  timeline?: TimelinePayload
  timelineFresh: Freshness
  workspace?: string
  learning?: LearningPayload
  research?: ResearchPayload
}

const TIMELINE_MAX_AGE_MS = 9000

const emptyCache = (session: string): SessionCache => ({ session, timelineFresh: createFreshness(TIMELINE_MAX_AGE_MS) })

export function EmbedApp() {
  const toasts = createToasts()
  const [host, setHost] = createSignal<HostContext>(initialHostContext())
  const [scope, setScope] = createSignal("all")
  const [kind, setKind] = createSignal("")
  const [evidence, setEvidence] = createSignal("")
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [hits, setHits] = createSignal<SearchHit[]>([])
  const [recall, setRecall] = createSignal<RecallResult | undefined>()
  const [searchError, setSearchError] = createSignal("")
  const [rememberOpen, setRememberOpen] = createSignal(false)
  const [sources, setSources] = createSignal<Record<string, ObservationSource[]>>({})
  let bridge: MemoryBridge | undefined
  let cachedProjects: ProjectRow[] = []
  let cachedConfig: MemoryConfigView | undefined
  let lastSlow = 0
  let cache = emptyCache(host().sessionID)
  const inflightSources = new Set<string>()
  const [busyIds, setBusyIds] = createSignal<Set<string>>(new Set())
  let searchGen = 0
  let recallGen = 0
  let flushPoll: AbortController | undefined
  const stopFlushPoll = () => {
    flushPoll?.abort()
    flushPoll = undefined
  }
  onCleanup(stopFlushPoll)

  applyTheme(host().theme)

  onMount(() => {
    bridge = createBridge({
      onContext: (ctx) => {
        const prev = host().sessionID
        setHost(ctx)
        applyTheme(ctx.theme)
        if (ctx.sessionID !== prev) {
          cache = emptyCache(ctx.sessionID)
          stopFlushPoll()
          searchGen++
          recallGen++
          setBusyIds(new Set<string>())
          setSources({})
          setHits([])
          setRecall(undefined)
          setSearchError("")
          poll.reset()
          void poll.reload()
        }
      },
      getContext: () => host(),
    })
  })
  onCleanup(() => bridge?.destroy())

  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const onScheme = () => {
    if (!host().theme) applyTheme(undefined)
  }
  media.addEventListener("change", onScheme)
  onCleanup(() => media.removeEventListener("change", onScheme))

  const poll = createPoll({
    intervalMs: 3000,
    paused: () => busyIds().size > 0 || searchOpen(),
    key: () => host().sessionID,
    fn: async (): Promise<Bundle> => {
      const session = host().sessionID || undefined
      const now = Date.now()
      const slow = now - lastSlow > 60_000
      if (slow || !cachedProjects.length) {
        lastSlow = now
        const [projects, config] = await Promise.all([
          fetchProjects().catch(() => cachedProjects),
          fetchConfig().catch(() => cachedConfig),
        ])
        cachedProjects = projects
        cachedConfig = config
      }
      const c = cache.session === (session ?? "") ? cache : (cache = emptyCache(session ?? ""))
      const [status, review] = await Promise.all([fetchStatus(session), fetchReview("open", session)])
      const project = cachedProjects.find((p) => p.id === status.session?.projectId)
      const workspace = project?.workspace
      const domain = project?.domain ?? "general"
      if (c.workspace !== workspace) {
        c.workspace = workspace
        c.learning = undefined
        c.research = undefined
      }
      const timelineEpoch = c.timelineFresh.begin()
      const wantTimeline = !c.timeline || c.timelineFresh.want(now)
      const [context, timeline, learning, research] = await Promise.all([
        session ? fetchContext(session).catch(() => undefined) : Promise.resolve(undefined),
        session && wantTimeline ? fetchTimeline(session).catch(() => c.timeline) : Promise.resolve(c.timeline),
        domain !== "research" ? fetchLearning(workspace).catch(() => c.learning) : Promise.resolve(undefined),
        domain !== "learning" ? fetchResearch(workspace).catch(() => c.research) : Promise.resolve(undefined),
      ])
      if (timeline && timeline !== c.timeline) {
        c.timeline = timeline
        c.timelineFresh.store(timelineEpoch, now)
      }
      c.learning = learning
      c.research = research
      return { status, review, context, timeline: c.timeline, learning, research, projects: cachedProjects, config: cachedConfig }
    },
  })

  const state = createMemo(() => deriveMemoryState(poll.data()?.status.global, poll.data()?.status.session))
  const reviewCount = createMemo(() => poll.data()?.review.length ?? 0)
  const domain = createMemo(() => {
    const st = poll.data()?.status.session
    return poll.data()?.projects.find((p) => p.id === st?.projectId)?.domain ?? "general"
  })
  const workspaceLabel = createMemo(() => {
    if (domain() === "research") return "Research"
    if (domain() === "learning") return "Learning"
    return "Workspace"
  })

  createEffect(() => {
    const s = state()
    const n = reviewCount()
    bridge?.status(s, n)
  })

  createEffect(() => {
    const obs = poll.data()?.timeline?.observations ?? []
    const missing = obs.slice(0, 40).filter((o) => !sources()[o.id] && !inflightSources.has(o.id))
    if (!missing.length) return
    const sessionAt = host().sessionID
    for (const o of missing) inflightSources.add(o.id)
    void Promise.all(
      missing.map(async (o) => {
        try {
          const d = await fetchObservation(o.id)
          return [o.id, d.sources ?? []] as const
        } catch {
          return [o.id, [] as ObservationSource[]] as const
        } finally {
          inflightSources.delete(o.id)
        }
      }),
    ).then((pairs) => {
      if (host().sessionID !== sessionAt) return
      setSources((prev) => {
        const next = { ...prev }
        for (const [id, src] of pairs) next[id] = src
        return next
      })
    })
  })

  const observations = createMemo(() => {
    const rows = poll.data()?.timeline?.observations ?? []
    return rows.filter((o) => {
      if (!matchesScope(o, scope())) return false
      if (kind() && o.kind !== kind()) return false
      if (evidence() && o.evidence_type !== evidence()) return false
      return o.status !== "forgotten"
    })
  })
  const obsIds = createMemo(() => observations().map((o) => o.id))
  const obsById = (id: string) => observations().find((o) => o.id === id)

  const emptyReason = createMemo(() => {
    const err = poll.error()
    const hasData = !!poll.data()
    if (!hasData && err?.status === 401) return "auth"
    if (!hasData && err?.status === 0) return "unreachable"
    if (!hasData && err) return "error"
    if (!host().sessionID) return "session"
    const st = poll.data()?.status.session
    const n = poll.data()?.timeline?.observations.length ?? 0
    if (st && st.capturedTokens === 0 && n === 0) return "empty"
    return ""
  })

  const banner = createMemo(() => {
    const err = poll.error()
    if (!err || !poll.data()) return ""
    if (err.status === 401) return "Unauthorized — token missing or invalid."
    if (err.status === 0) return "Memory API unreachable. Showing last data."
    return err.message
  })

  const reflectAt = () => poll.data()?.config?.reflect?.thresholdTokens ?? 40_000
  const due = (): DueReview[] => poll.data()?.learning?.due ?? []
  const conflicts = (): ClaimRow[] => poll.data()?.research?.conflicts ?? []

  const onError = (msg: string) => toasts.error(msg)
  const reload = () => void poll.reload()
  /** After a mutation: the cached timeline is stale however young it is. */
  const refresh = () => {
    cache.timelineFresh.invalidate()
    void poll.reload()
  }

  const quiz = () => {
    const names = due()
      .map((d) => d.name)
      .join(", ")
    const text = names
      ? `Quiz me on: ${names}. Ask one question at a time and wait for my answer.`
      : "Quiz me on concepts that are due for review. Ask one question at a time."
    if (bridge?.embedded) bridge.insert(text)
    else toasts.ok("Quiz prompt copied to composer when embedded in OpenCode.")
  }

  const openConflicts = () => {
    const first = conflicts()[0]
    if (first && bridge?.embedded) {
      bridge.insert(`Ask about this contested claim: ${first.statement}`)
      return
    }
    bridge?.openDashboard("/app/research")
  }

  const runSearch = async () => {
    const gen = ++searchGen
    recallGen++
    setRecall(undefined)
    setSearchError("")
    try {
      const data = await fetchSearch(query(), { session: host().sessionID || undefined, limit: 30 })
      if (gen !== searchGen) return
      setHits(unwrapHits(data))
    } catch (e) {
      if (gen !== searchGen) return
      setSearchError(errorMessage(e))
    }
  }

  const pickHit = async (hit: SearchHit) => {
    const gen = ++recallGen
    try {
      const result = await loadRecall(hit.row, host().sessionID || undefined)
      if (gen !== recallGen) return
      setRecall(result)
    } catch (e) {
      if (gen !== recallGen) return
      setRecall({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const pause = async () => {
    try {
      await setPaused(!(poll.data()?.status.global.paused ?? false))
      reload()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const flush = async () => {
    const session = host().sessionID
    if (!session) return onError("No session selected")
    stopFlushPoll()
    const ctl = new AbortController()
    flushPoll = ctl
    try {
      const start = parseFlushResponse(await flushSession(session))
      if (ctl.signal.aborted) return
      toasts.ok(flushStartMessage(start))
      refresh()
      if (start.kind === "done") return
      const final = await pollCommand(start.commandId, { fetch: fetchCommand, signal: ctl.signal })
      if (ctl.signal.aborted) return
      const out = commandOutcome(final)
      if (out.tone === "error") onError(out.text)
      else toasts.ok(out.text)
      if (final?.state === "done") refresh()
    } catch (e) {
      if (!ctl.signal.aborted) onError(flushErrorText(e))
    } finally {
      if (flushPoll === ctl) flushPoll = undefined
    }
  }

  const fatal = () => emptyReason() === "auth" || emptyReason() === "unreachable" || emptyReason() === "error"

  return (
    <div class="flex h-full min-h-0 flex-col bg-[var(--om-bg)] text-[var(--om-fg)]">
      <header class="flex items-center gap-2 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <h1 class="text-[13px] font-semibold">Memory</h1>
        <StatusPill
          state={state()}
          title={statusTitle(state(), poll.data()?.status.global, poll.data()?.status.session)}
          onErrorClick={() => bridge?.openDashboard("/app/runs")}
          onResume={poll.data()?.status.global.paused ? () => void pause() : undefined}
        />
        <div class="ml-auto flex items-center">
          <Button onClick={() => setSearchOpen(true)}>Search</Button>
          <Menu label="Memory actions">
            <MenuItem onClick={() => bridge?.openDashboard("/app")}>Open full dashboard</MenuItem>
            <Show when={host().sessionID}>
              <MenuItem onClick={() => setRememberOpen(true)}>Remember…</MenuItem>
            </Show>
            <MenuItem onClick={() => void flush()}>Flush now</MenuItem>
            <MenuItem onClick={() => void pause()}>{poll.data()?.status.global.paused ? "Resume" : "Pause"}</MenuItem>
          </Menu>
        </div>
      </header>
      <Show when={banner()}>
        <Banner>{banner()}</Banner>
      </Show>
      <PauseReasonBanner global={poll.data()?.status.global} onResume={() => void pause()} />
      <div class="border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <ScopeChips value={scope()} onChange={setScope} workspaceLabel={workspaceLabel()} />
      </div>
      <ViewBoundary resetKey={() => host().sessionID}>
        <Show
          when={!fatal()}
          fallback={
            <EmptyState
              title={emptyReason() === "auth" ? "Unauthorized" : emptyReason() === "unreachable" ? "Memory API unreachable" : "Something went wrong"}
              body={
                emptyReason() === "auth"
                  ? "The dashboard token is missing or invalid."
                  : poll.error()?.message || "The plugin HTTP server did not respond."
              }
            />
          }
        >
          <Show
            when={emptyReason() !== "session"}
            fallback={<EmptyState title="No session selected" body="Open a session in OpenCode to see observational memory for this tab." />}
          >
            <div class="min-h-0 flex-1 overflow-auto px-2 py-2">
              <Show when={poll.data()?.status.global}>
                {(g) => (
                  <MemoryGauges
                    global={g()}
                    session={poll.data()?.status.session}
                    reflectThreshold={reflectAt()}
                    generation={poll.data()?.context?.latest?.memory_generation}
                    onPause={() => void pause()}
                  />
                )}
              </Show>
              <div class="mt-2">
                <InContextNow session={poll.data()?.status.session} context={poll.data()?.context} />
              </div>
              <section class="mt-2 rounded border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
                <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">Needs review ({reviewCount()})</h2>
                <ReviewList items={poll.data()?.review ?? []} onDone={refresh} onError={onError} />
              </section>
              <div class="mt-2">
                <DomainCards domain={domain()} due={due()} conflicts={conflicts()} onQuiz={quiz} onOpenConflicts={openConflicts} />
              </div>
              <Show when={emptyReason() === "empty"}>
                <EmptyState title="Nothing captured yet" body="This session has no retained messages or observations." />
              </Show>
              <section class="mt-2 rounded border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
                <div class="mb-1 flex items-center justify-between gap-2">
                  <h2 class="text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">Timeline</h2>
                  <div class="flex gap-1">
                    <Select
                      label="Kind"
                      value={kind()}
                      onChange={setKind}
                      options={[{ value: "", label: "Kind" }, ...KINDS.map((k) => ({ value: k, label: k }))]}
                    />
                    <Select
                      label="Evidence"
                      value={evidence()}
                      onChange={setEvidence}
                      options={[{ value: "", label: "Evidence" }, ...EVIDENCE_TYPES.map((k) => ({ value: k, label: k }))]}
                    />
                  </div>
                </div>
                <For each={obsIds()} fallback={<p class="text-neutral-500">No observations in this filter.</p>}>
                  {(id, i) => {
                    const row = () => obsById(id) as ObservationRow
                    const day = () => formatDay(row().event_at ?? row().observed_at)
                    const prev = () => {
                      const pid = obsIds()[i() - 1]
                      if (!pid) return ""
                      const r = obsById(pid)
                      return r ? formatDay(r.event_at ?? r.observed_at) : ""
                    }
                    return (
                      <Show when={obsById(id)}>
                        {(r) => (
                          <div>
                            <Show when={day() !== prev()}>
                              <p class="text-[11px] font-medium text-neutral-500">{day()}</p>
                            </Show>
                            <ObservationCard
                              row={r()}
                              sources={sources()[r().id]}
                              bridge={bridge}
                              onChanged={refresh}
                              onError={onError}
                              onNotice={(msg) => toasts.ok(msg)}
                              onBusy={(busy) => {
                                setBusyIds((prev) => {
                                  if (busy === prev.has(id)) return prev
                                  const next = new Set(prev)
                                  if (busy) next.add(id)
                                  else next.delete(id)
                                  return next
                                })
                              }}
                            />
                          </div>
                        )}
                      </Show>
                    )
                  }}
                </For>
              </section>
            </div>
          </Show>
        </Show>
      </ViewBoundary>
      <ViewBoundary resetKey={() => host().sessionID}>
        <SearchPanel
          open={searchOpen()}
          onClose={() => setSearchOpen(false)}
          session={host().sessionID}
          hits={hits()}
          query={query()}
          onQuery={setQuery}
          onSearch={() => void runSearch()}
          error={searchError()}
          recall={recall()}
          onPick={(h) => void pickHit(h)}
        />
      </ViewBoundary>
      <RememberDialog
        open={rememberOpen()}
        session={host().sessionID || undefined}
        onClose={() => setRememberOpen(false)}
        onSaved={(msg) => {
          setRememberOpen(false)
          toasts.ok(msg)
          refresh()
        }}
      />
      <ToastHost items={toasts.items()} />
    </div>
  )
}
