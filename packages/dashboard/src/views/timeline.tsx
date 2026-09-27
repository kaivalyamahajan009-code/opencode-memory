import { For, Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js"
import { fetchObservation, fetchTimeline } from "../api"
import { formatDay } from "../format"
import { useDash } from "../store"
import { EVIDENCE_TYPES, KINDS, STATUSES, type ObservationDetail, type ObservationRow, type RecallResult, type SessionListItem } from "../types"
import { Button, Select } from "../ui"
import { ObservationCard, RecallView, RememberDialog, loadRecall, matchesScope } from "../widgets"

export default function Timeline() {
  const dash = useDash()
  const [scope, setScope] = createSignal("all")
  const [kind, setKind] = createSignal("")
  const [evidence, setEvidence] = createSignal("")
  const [status, setStatus] = createSignal("")
  const [selected, setSelected] = createSignal<ObservationRow | undefined>()
  const [recall, setRecall] = createSignal<RecallResult | undefined>()
  const [rememberOpen, setRememberOpen] = createSignal(false)
  let recallGen = 0

  const sessionId = () => dash.host().sessionID
  const [tl, { refetch }] = createResource(sessionId, async (id) => (id ? { session: id, data: await fetchTimeline(id) } : undefined))
  /** Only the selected session's timeline; the previous session's rows are not shown while the new one loads. */
  const timeline = () => {
    const t = tl.latest
    return t && t.session === sessionId() ? t.data : undefined
  }
  createEffect(
    on(
      sessionId,
      () => {
        recallGen++
        setSelected(undefined)
        setRecall(undefined)
      },
      { defer: true },
    ),
  )
  const [detailError, setDetailError] = createSignal("")
  const [detail] = createResource(
    () => selected()?.id,
    async (id): Promise<ObservationDetail | undefined> => {
      setDetailError("")
      try {
        return await fetchObservation(id)
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : String(e))
        return undefined
      }
    },
    { initialValue: undefined },
  )
  const shownDetail = () => {
    const d = detail.latest
    return d && d.id === selected()?.id ? d : undefined
  }

  const rows = createMemo(() => {
    const list = timeline()?.observations ?? []
    return list.filter((o) => {
      if (!matchesScope(o, scope())) return false
      if (kind() && o.kind !== kind()) return false
      if (evidence() && o.evidence_type !== evidence()) return false
      if (status() && o.status !== status()) return false
      return true
    })
  })
  const rowById = (id: string) => rows().find((o) => o.id === id)

  const grouped = createMemo(() => {
    const map = new Map<string, string[]>()
    for (const o of rows()) {
      const key = formatDay(o.event_at ?? o.observed_at)
      const list = map.get(key) ?? []
      list.push(o.id)
      map.set(key, list)
    }
    return [...map.entries()]
  })

  const chain = createMemo(() => {
    const d = shownDetail()
    if (!d) return [] as string[]
    const parts = [`${d.id} (${d.status})`]
    if (d.supersedes_id) parts.unshift(`supersedes ${d.supersedes_id}`)
    if (d.superseded_by) parts.push(`superseded by ${d.superseded_by}`)
    return parts
  })

  const pickSession = (id: string) => {
    dash.setHost({ ...dash.host(), sessionID: id })
  }

  const err = (msg: string) => dash.toasts.error(msg)

  const openRecall = async (id: string) => {
    const gen = ++recallGen
    const row = rowById(id)
    setSelected(row)
    if (!row) return
    try {
      const result = await loadRecall(row, sessionId() || undefined)
      if (gen !== recallGen) return
      setRecall(result)
    } catch (e) {
      if (gen !== recallGen) return
      setRecall({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div class="flex h-full min-h-0">
      <div class="min-w-0 flex-1 overflow-auto p-4">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <h1 class="text-[15px] font-semibold">Timeline</h1>
          <SessionSelect value={sessionId()} sessions={dash.sessions()} onChange={pickSession} />
          <Select
            label="Scope"
            value={scope()}
            onChange={setScope}
            options={[
              { value: "all", label: "Scope" },
              { value: "session", label: "Session" },
              { value: "project", label: "Project" },
              { value: "workspace", label: "Workspace" },
              { value: "user", label: "User" },
            ]}
          />
          <Select label="Kind" value={kind()} onChange={setKind} options={[{ value: "", label: "Kind" }, ...KINDS.map((k) => ({ value: k, label: k }))]} />
          <Select
            label="Evidence"
            value={evidence()}
            onChange={setEvidence}
            options={[{ value: "", label: "Evidence" }, ...EVIDENCE_TYPES.map((k) => ({ value: k, label: k }))]}
          />
          <Select
            label="Status"
            value={status()}
            onChange={setStatus}
            options={[{ value: "", label: "Status" }, ...STATUSES.map((k) => ({ value: k, label: k }))]}
          />
          <Show when={sessionId()}>
            <Button onClick={() => setRememberOpen(true)}>Remember…</Button>
          </Show>
        </div>
        <RememberDialog
          open={rememberOpen()}
          session={sessionId() || undefined}
          onClose={() => setRememberOpen(false)}
          onSaved={(msg) => {
            setRememberOpen(false)
            dash.toasts.ok(msg)
            void refetch()
          }}
        />
        <Show when={sessionId()} fallback={<p class="text-neutral-500">Pick a session to load its timeline.</p>}>
          <For each={grouped()} fallback={<p class="text-neutral-500">{!timeline() && tl.loading ? "Loading…" : "No observations."}</p>}>
            {([day, ids]) => (
              <div class="mb-3">
                <p class="text-[11px] font-medium text-neutral-500">{day}</p>
                <For each={ids}>
                  {(id) => (
                    <Show when={rowById(id)}>
                      {(row) => (
                        <ObservationCard
                          row={row()}
                          sources={shownDetail()?.id === id ? shownDetail()?.sources : undefined}
                          onChanged={() => void refetch()}
                          onError={err}
                          onNotice={(msg) => dash.toasts.ok(msg)}
                          onSelect={(r) => {
                            if (r.id === selected()?.id) return
                            recallGen++
                            setRecall(undefined)
                            setSelected(r)
                          }}
                          onRecall={(oid) => void openRecall(oid)}
                        />
                      )}
                    </Show>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
      <Show when={selected()}>
        <aside class="w-[22rem] shrink-0 overflow-auto border-l border-neutral-200 p-3 dark:border-neutral-800" aria-label="Observation detail">
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-[13px] font-medium">Detail</h2>
            <Button
              onClick={() => {
                setSelected(undefined)
                setRecall(undefined)
              }}
            >
              Close
            </Button>
          </div>
          <Show when={!shownDetail() && detail.loading}>
            <p class="text-neutral-500">Loading…</p>
          </Show>
          <Show when={!shownDetail() && detailError()}>
            <p class="text-red-700 dark:text-red-400">Could not load this observation: {detailError()}</p>
          </Show>
          <Show when={shownDetail()}>
            {(d) => (
              <div class="space-y-2">
                <p class="whitespace-pre-wrap">{d().content}</p>
                <p class="text-[11px] text-neutral-500">
                  {d().kind} · {d().status} · {d().scope_kind}
                </p>
                <h3 class="text-[11px] font-semibold tracking-wide uppercase">Sources</h3>
                <For each={d().sources} fallback={<p class="text-neutral-500">No sources</p>}>
                  {(s) => (
                    <p>
                      {s.session_id} seq {s.start_seq}–{s.end_seq}
                    </p>
                  )}
                </For>
                <h3 class="text-[11px] font-semibold tracking-wide uppercase">Events</h3>
                <For each={d().events} fallback={<p class="text-neutral-500">No events</p>}>
                  {(e) => (
                    <p>
                      {e.type} · {e.actor} · {new Date(e.at).toLocaleString()}
                    </p>
                  )}
                </For>
                <h3 class="text-[11px] font-semibold tracking-wide uppercase">Supersession</h3>
                <For each={chain()}>{(line) => <p>{line}</p>}</For>
              </div>
            )}
          </Show>
          <Show when={recall()}>
            <div class="mt-3 border-t border-neutral-200 pt-2 dark:border-neutral-800">
              <h3 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Recall preview</h3>
              <RecallView result={recall()} />
            </div>
          </Show>
        </aside>
      </Show>
    </div>
  )
}

function SessionSelect(props: { value: string; sessions: SessionListItem[]; onChange: (id: string) => void }) {
  let el: HTMLSelectElement | undefined
  const ids = createMemo(() => props.sessions.map((s) => s.id))
  createEffect(() => {
    ids()
    const v = props.value
    queueMicrotask(() => {
      if (el) el.value = v
    })
  })
  return (
    <label class="text-[11px] text-neutral-500">
      Session
      <select
        ref={(node) => {
          el = node
        }}
        class="ml-1 rounded border border-neutral-300 bg-white px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-900"
        value={props.value}
        aria-label="Session"
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <option value="">Select session</option>
        <For each={ids()}>
          {(id) => {
            const s = () => props.sessions.find((x) => x.id === id)
            return <option value={id}>{s()?.title || id}</option>
          }}
        </For>
      </select>
    </label>
  )
}
