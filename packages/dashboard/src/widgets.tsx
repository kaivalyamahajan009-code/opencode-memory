import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js"
import {
  decideReview,
  editObservation,
  fetchObservation,
  fetchRecall,
  forgetCandidates,
  forgetObservations,
  pinObservation,
  remember,
  supersedeObservation,
} from "./api"
import type { MemoryBridge } from "./bridge"
import { errorMessage, writeErrorText } from "./errors"
import { forgetBody, forgetFailure, forgetOutcome, forgetRequest, purgeLabel, PURGE_SOURCES_DEFAULT, type ForgetOutcome } from "./forget-select"
import { formatTokens, formatUsd, observedAgo, sourceLabel } from "./format"
import { hasTruncatedPart, mergeRecall, nextRecallRequest, recallRequestFor } from "./recall"
import { canEditReview, isVaultConflict, reviewLabel, reviewText } from "./review-kind"
import { pausedBannerText, STATE_LABEL } from "./status"
import type {
  ClaimRow,
  ContextPayload,
  DueReview,
  ForgetCandidate,
  GlobalStatus,
  MemoryState,
  ObservationRow,
  ObservationSource,
  RecallOk,
  RecallResult,
  ReviewItem,
  SearchHit,
  SessionStatus,
} from "./types"
import { KINDS } from "./types"
import { Banner, Button, Chip, Dialog, Gauge, LiveFeedback, Select, TextArea, TextInput, type Feedback } from "./ui"

export function PauseReasonBanner(props: { global?: GlobalStatus; onResume: () => void }) {
  return (
    <Show when={pausedBannerText(props.global)}>
      {(text) => (
        <Banner kind="warn">
          <span class="flex flex-wrap items-center gap-2">
            <span>{text()}</span>
            <Button onClick={props.onResume}>Resume</Button>
          </span>
        </Banner>
      )}
    </Show>
  )
}

/** `onResume` makes the pill resume memory while paused; pass it only when memory is globally paused. */
export function StatusPill(props: { state: MemoryState; title?: string; onErrorClick?: () => void; onResume?: () => void }) {
  const title = () => props.title ?? STATE_LABEL[props.state]
  const resumable = () => props.state === "paused" && !!props.onResume
  const color = () =>
    ({
      idle: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
      buffering: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
      observing: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
      reflecting: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
      paused: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
      error: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
    })[props.state]
  return (
    <button
      type="button"
      class={`rounded-full px-2 py-0.5 text-[11px] font-medium ${color()}`}
      title={resumable() ? `${title()} — click to resume` : title()}
      aria-label={`Memory status ${title()}${resumable() ? ". Click to resume" : ""}`}
      onClick={() => {
        if (props.state === "error") props.onErrorClick?.()
        else if (props.state === "paused") props.onResume?.()
      }}
    >
      {STATE_LABEL[props.state]}
      <Show when={resumable()}>
        <span aria-hidden="true"> · Resume</span>
      </Show>
    </button>
  )
}

export function ScopeChips(props: {
  value: string
  onChange: (v: string) => void
  workspaceLabel: string
}) {
  const items = createMemo(() => [
    { id: "all", label: "All" },
    { id: "session", label: "Session" },
    { id: "project", label: "Project" },
    { id: "workspace", label: props.workspaceLabel },
    { id: "user", label: "User" },
  ])
  return (
    <div class="flex flex-wrap gap-1" role="group" aria-label="Memory scope">
      <For each={items()}>
        {(it) => (
          <Chip active={props.value === it.id} onClick={() => props.onChange(it.id)}>
            {it.label}
          </Chip>
        )}
      </For>
    </div>
  )
}

export function MemoryGauges(props: {
  global: GlobalStatus
  session?: SessionStatus
  reflectThreshold: number
  generation?: number
  onPause: () => void
}) {
  const unobserved = () => props.session?.unobservedTokens ?? 0
  const activation = () => props.session?.activationTokens ?? 30_000
  const obsTokens = () => props.session?.observationTokens ?? 0
  const usage = () => props.global.usage
  return (
    <div class="space-y-1.5">
      <Gauge
        label="Unobserved"
        value={unobserved()}
        max={activation()}
        display={`${formatTokens(unobserved())} / ${formatTokens(activation())}`}
      />
      <Gauge
        label="Observations"
        value={obsTokens()}
        max={props.reflectThreshold}
        display={`${formatTokens(obsTokens())} / ${formatTokens(props.reflectThreshold)}${props.generation != null ? `   gen ${props.generation}` : ""}`}
      />
      <div class="flex items-center justify-between gap-2 pt-0.5">
        <p class="text-neutral-500 dark:text-neutral-400">
          Today: {usage().runs} runs, {formatTokens(usage().tokens)} tokens, {formatUsd(usage().costUsd)}
        </p>
        <Button onClick={props.onPause}>{props.global.paused ? "Resume memory" : "Pause memory"}</Button>
      </div>
    </div>
  )
}

export function InContextNow(props: { session?: SessionStatus; context?: ContextPayload }) {
  const [open, setOpen] = createSignal(false)
  const block = () => props.context?.latest?.block ?? ""
  const tokens = () => props.context?.latest?.token_est ?? props.session?.injectedTokens ?? 0
  return (
    <section class="rounded border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
      <div class="mb-1 flex items-center justify-between gap-2">
        <h2 class="text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">In context now</h2>
        <div class="flex items-center gap-2">
          <span class="tabular-nums text-neutral-500">{formatTokens(tokens())} tok</span>
          <Button onClick={() => setOpen((v) => !v)}>{open() ? "Collapse" : "Expand"}</Button>
        </div>
      </div>
      <p>
        <span class="text-neutral-500">Current task: </span>
        {props.session?.currentTask || "—"}
      </p>
      <p>
        <span class="text-neutral-500">Suggested next: </span>
        {props.session?.suggestedNext || "—"}
      </p>
      <Show when={open()}>
        <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-[11px] dark:bg-neutral-950">
          {block() || "No injected block for this session yet."}
        </pre>
      </Show>
    </section>
  )
}

export function ReviewList(props: {
  items: ReviewItem[]
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [editing, setEditing] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal("")
  const [overwriteId, setOverwriteId] = createSignal<string | null>(null)
  const [overwriteError, setOverwriteError] = createSignal("")
  const ids = createMemo(() => props.items.map((it) => it.id))
  const byId = (id: string) => props.items.find((it) => it.id === id)

  const act = async (id: string, decision: "approve" | "reject", content?: string, inDialog = false) => {
    try {
      await decideReview(id, decision, content)
      setEditing(null)
      setOverwriteId(null)
      props.onDone()
    } catch (e) {
      if (inDialog) setOverwriteError(errorMessage(e))
      else props.onError(errorMessage(e))
    }
  }
  const openOverwrite = (id: string) => {
    setOverwriteError("")
    setOverwriteId(id)
  }

  return (
    <div class="space-y-2">
      <For each={ids()} fallback={<p class="text-neutral-500">No items need review.</p>}>
        {(id) => {
          const it = () => byId(id)
          return (
            <Show when={it()}>
              {(item) => (
                <div class="rounded border border-neutral-200 p-2 dark:border-neutral-800">
                  <p class="whitespace-pre-wrap">{reviewText(item())}</p>
                  <p class="mt-0.5 text-[11px] text-neutral-500">
                    {reviewLabel(item())}
                    {isVaultConflict(item()) ? "" : ` · ${item().evidence_type || item().reason}`}
                    {item().confidence != null ? ` · ${item().confidence!.toFixed(2)}` : ""}
                  </p>
                  <Show when={isVaultConflict(item())}>
                    <p class="mt-1 text-[11px] text-neutral-500">This is a vault file conflict, not an observation approval.</p>
                    <div class="mt-1 flex flex-wrap gap-1">
                      <Button kind="primary" onClick={() => void act(item().id, "approve")}>
                        Keep my file edit
                      </Button>
                      <Button kind="danger" onClick={() => openOverwrite(item().id)}>
                        Overwrite file from memory
                      </Button>
                    </div>
                    <Dialog
                      open={overwriteId() === item().id}
                      title="Overwrite vault file"
                      onClose={() => setOverwriteId(null)}
                      footer={
                        <>
                          <Button onClick={() => setOverwriteId(null)}>Cancel</Button>
                          <Button kind="danger" onClick={() => void act(item().id, "reject", undefined, true)}>
                            Overwrite
                          </Button>
                        </>
                      }
                    >
                      <LiveFeedback feedback={overwriteError() ? { tone: "error", text: overwriteError() } : undefined} />
                      <p>Replace the file on disk with the version stored in memory? Your unimported edits will be lost.</p>
                    </Dialog>
                  </Show>
                  <Show when={!isVaultConflict(item())}>
                    <Show when={editing() === item().id}>
                      <TextArea label="Edited content" value={draft()} onInput={setDraft} />
                    </Show>
                    <div class="mt-1 flex flex-wrap gap-1">
                      <Button kind="primary" onClick={() => void act(item().id, "approve", editing() === item().id ? draft() : undefined)}>
                        Approve
                      </Button>
                      <Show when={canEditReview(item())}>
                        <Button
                          onClick={() => {
                            if (editing() === item().id) void act(item().id, "approve", draft())
                            else {
                              setEditing(item().id)
                              setDraft(item().content || "")
                            }
                          }}
                        >
                          Edit
                        </Button>
                      </Show>
                      <Button kind="danger" onClick={() => void act(item().id, "reject")}>
                        Reject
                      </Button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          )
        }}
      </For>
    </div>
  )
}

export function DomainCards(props: {
  domain: string
  due: DueReview[]
  conflicts: ClaimRow[]
  onQuiz: () => void
  onOpenConflicts: () => void
}) {
  return (
    <div class="space-y-2">
      <Show when={props.domain !== "research"}>
        <div class="flex items-center justify-between rounded border border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
          <p>
            <span class="text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">Due for review</span>
            <span class="ml-2">{props.due.length} concepts</span>
          </p>
          <Button onClick={props.onQuiz} disabled={!props.due.length}>
            Quiz me
          </Button>
        </div>
      </Show>
      <Show when={props.domain !== "learning"}>
        <div class="flex items-center justify-between rounded border border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
          <p>
            <span class="text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">Open conflicts</span>
            <span class="ml-2">
              {props.conflicts.length} claim{props.conflicts.length === 1 ? "" : "s"}
            </span>
          </p>
          <Button onClick={props.onOpenConflicts} disabled={!props.conflicts.length}>
            Open
          </Button>
        </div>
      </Show>
    </div>
  )
}

export function ObservationCard(props: {
  row: ObservationRow
  sources?: ObservationSource[]
  bridge?: MemoryBridge
  onChanged: () => void
  onError: (msg: string) => void
  onSelect?: (row: ObservationRow) => void
  onRecall?: (id: string) => void
  onBusy?: (busy: boolean) => void
  onNotice?: (msg: string) => void
}) {
  const [forgetOpen, setForgetOpen] = createSignal(false)
  const [editOpen, setEditOpen] = createSignal(false)
  const [supOpen, setSupOpen] = createSignal(false)
  const [draft, setDraft] = createSignal(props.row.content)
  const [reason, setReason] = createSignal("")
  const [dialogError, setDialogError] = createSignal("")
  const errorFeedback = (): Feedback | undefined => (dialogError() ? { tone: "error", text: dialogError() } : undefined)
  const when = () => props.row.event_at ?? props.row.observed_at
  const src = () => props.sources?.[0]
  const showSource = () => !!props.bridge?.embedded || !!props.onRecall

  createEffect(() => props.onBusy?.(editOpen() || forgetOpen() || supOpen()))
  onCleanup(() => props.onBusy?.(false))

  const navigate = () => {
    if (props.bridge?.embedded) {
      const s = src()
      if (!s) {
        void fetchObservation(props.row.id)
          .then((d) => {
            const first = d.sources?.[0]
            if (first) props.bridge?.navigate(first.session_id, first.start_message_id)
            else props.onError("This observation has no recorded source")
          })
          .catch((e) => props.onError(e instanceof Error ? e.message : String(e)))
        return
      }
      props.bridge.navigate(s.session_id, s.start_message_id)
      return
    }
    props.onRecall?.(props.row.id)
  }

  const doPin = async () => {
    try {
      await pinObservation(props.row.id, !props.row.pinned)
      props.onChanged()
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e))
    }
  }
  const doEdit = async () => {
    setDialogError("")
    try {
      await editObservation(props.row.id, draft())
      setEditOpen(false)
      props.onChanged()
    } catch (e) {
      setDialogError(writeErrorText(e))
    }
  }
  const doSup = async () => {
    setDialogError("")
    try {
      await supersedeObservation(props.row.id, draft(), reason() || "replaced from dashboard")
      setSupOpen(false)
      props.onChanged()
    } catch (e) {
      setDialogError(writeErrorText(e))
    }
  }

  return (
    <article class="border-b border-neutral-200 py-2 last:border-b-0 dark:border-neutral-800">
      <p class="text-[11px] text-neutral-500">
        {formatTimeSafe(when())} · {props.row.kind} · {props.row.evidence_type} · {props.row.confidence.toFixed(2)}
        <Show when={props.row.pinned}> · pinned</Show>
      </p>
      <button type="button" class="mt-0.5 w-full text-left whitespace-pre-wrap" onClick={() => props.onSelect?.(props.row)}>
        {props.row.content}
      </button>
      <div class="mt-1 flex flex-wrap items-center gap-1">
        <Show when={showSource()}>
          <button type="button" class="text-[11px] text-neutral-500 underline decoration-dotted" onClick={navigate}>
            {src() ? `Source: ${sourceLabel(src()!.start_seq, src()!.end_seq)}` : "Source"}
          </button>
        </Show>
        <Button onClick={() => void doPin()}>{props.row.pinned ? "Unpin" : "Pin"}</Button>
        <Button
          onClick={() => {
            setDraft(props.row.content)
            setDialogError("")
            setEditOpen(true)
          }}
        >
          Edit
        </Button>
        <Button
          onClick={() => {
            setDraft(props.row.content)
            setReason("")
            setDialogError("")
            setSupOpen(true)
          }}
        >
          Supersede
        </Button>
        <Button kind="danger" onClick={() => setForgetOpen(true)}>
          Forget
        </Button>
      </div>
      <Dialog
        open={editOpen()}
        title="Edit observation"
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <Button onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button kind="primary" onClick={() => void doEdit()}>
              Save
            </Button>
          </>
        }
      >
        <LiveFeedback feedback={errorFeedback()} />
        <TextArea label="Content" value={draft()} onInput={setDraft} />
      </Dialog>
      <Dialog
        open={supOpen()}
        title="Supersede observation"
        onClose={() => setSupOpen(false)}
        footer={
          <>
            <Button onClick={() => setSupOpen(false)}>Cancel</Button>
            <Button kind="primary" onClick={() => void doSup()}>
              Replace
            </Button>
          </>
        }
      >
        <LiveFeedback feedback={errorFeedback()} />
        <div class="space-y-2">
          <TextArea label="New content" value={draft()} onInput={setDraft} />
          <TextInput label="Reason" value={reason()} onInput={setReason} placeholder="Reason" />
        </div>
      </Dialog>
      <ForgetDialog
        open={forgetOpen()}
        row={props.row}
        onClose={(changed) => {
          setForgetOpen(false)
          if (changed) props.onChanged()
        }}
        onForgotten={(outcome) => {
          setForgetOpen(false)
          props.onNotice?.(outcome.message)
          props.onChanged()
        }}
      />
    </article>
  )
}

const REMEMBER_SCOPES = ["session", "project", "workspace", "user"] as const

/**
 * Adds a memory as the user, into `session` when given. Refusals stay inline: 400 for
 * instruction-like or invalid content, 409 when the session was forgotten, excluded or deleted.
 */
export function RememberDialog(props: { open: boolean; session?: string; project?: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [content, setContent] = createSignal("")
  const [kind, setKind] = createSignal("fact")
  const [scope, setScope] = createSignal<string>("project")
  const [error, setError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setContent("")
        setError("")
      },
    ),
  )
  const save = async () => {
    const text = content().trim()
    if (!text || saving()) return
    setError("")
    setSaving(true)
    try {
      const r = await remember({
        content: text,
        kind: kind(),
        scope: scope(),
        ...(props.session ? { session: props.session } : {}),
        ...(props.project ? { project: props.project } : {}),
      })
      props.onSaved(r.status === "pending_review" ? "Memory saved; it waits in Review before it is used" : "Memory saved")
    } catch (e) {
      setError(writeErrorText(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog
      open={props.open}
      title="Remember"
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button kind="primary" disabled={saving() || !content().trim()} onClick={() => void save()}>
            {saving() ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <LiveFeedback feedback={error() ? { tone: "error", text: error() } : undefined} />
      <div class="space-y-2">
        <TextArea label="Memory" value={content()} onInput={setContent} rows={3} />
        <div class="flex flex-wrap gap-2">
          <Select label="Kind" value={kind()} onChange={setKind} options={KINDS.filter((k) => k !== "condensed").map((k) => ({ value: k, label: k }))} />
          <Select label="Scope" value={scope()} onChange={setScope} options={REMEMBER_SCOPES.map((s) => ({ value: s, label: s }))} />
        </div>
      </div>
    </Dialog>
  )
}

function formatTimeSafe(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/**
 * Always a global (user) forget. Complete results close via `onForgotten`; partial results, 404s and
 * errors stay inline, and `onClose(changed)` says whether the list must be refreshed.
 */
export function ForgetDialog(props: {
  open: boolean
  row?: ObservationRow
  onClose: (changed: boolean) => void
  onForgotten: (outcome: ForgetOutcome) => void
}) {
  const [cands] = createResource(
    () => (props.open && props.row ? props.row.content : ""),
    async (text) => {
      if (!text) return [] as ForgetCandidate[]
      try {
        return await forgetCandidates(text)
      } catch {
        return [] as ForgetCandidate[]
      }
    },
    { initialValue: [] as ForgetCandidate[] },
  )
  const [ticked, setTicked] = createSignal<Record<string, boolean>>({})
  const [purge, setPurge] = createSignal(PURGE_SOURCES_DEFAULT)
  const [busy, setBusy] = createSignal(false)
  const [feedback, setFeedback] = createSignal<ForgetOutcome | undefined>()
  let changed = false
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setTicked({})
        setPurge(PURGE_SOURCES_DEFAULT)
        setFeedback(undefined)
        changed = false
      },
    ),
  )
  const settled = () => {
    const f = feedback()
    return !!f && f.tone !== "error"
  }
  const close = () => {
    const c = changed
    changed = false
    props.onClose(c)
  }
  const extras = () => cands.latest.filter((c) => c.id !== props.row?.id)
  const request = () =>
    forgetRequest(
      props.row?.id ?? "",
      extras()
        .filter((c) => ticked()[c.id])
        .map((c) => c.id),
      purge(),
    )
  const count = () => request().ids.length
  const loading = () => cands.loading
  const confirm = async () => {
    if (!props.row || loading() || busy() || settled()) return
    const req = request()
    setBusy(true)
    setFeedback(undefined)
    try {
      const outcome = forgetOutcome(req.ids, await forgetObservations(forgetBody(req)))
      if (outcome.complete) {
        props.onForgotten(outcome)
        return
      }
      changed ||= outcome.changed
      setFeedback(outcome)
    } catch (e) {
      const outcome = forgetFailure(e)
      changed ||= outcome.changed
      setFeedback(outcome)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={props.open}
      title="Forget memory"
      onClose={close}
      footer={
        <Show
          when={!settled()}
          fallback={
            <Button kind="primary" onClick={close}>
              Close
            </Button>
          }
        >
          <Button onClick={close}>Cancel</Button>
          <Button kind="danger" disabled={busy() || loading()} onClick={() => void confirm()}>
            Forget {count()} item{count() === 1 ? "" : "s"}
          </Button>
        </Show>
      }
    >
      <LiveFeedback feedback={feedback() ? { tone: feedback()!.tone, text: feedback()!.message } : undefined} />
      <p class="mb-2">
        This hard-deletes {count()} observation{count() === 1 ? "" : "s"} and keeps a tombstone. Copies of the same content in other projects
        are forgotten too.
        {purge()
          ? ` The cited conversation parts of all ${count()} will also be deleted.`
          : " The source conversation is kept."}
      </p>
      <Show when={props.row}>
        <p class="whitespace-pre-wrap rounded bg-neutral-50 p-2 dark:bg-neutral-950">{props.row!.content}</p>
      </Show>
      <label class="mt-2 flex items-start gap-2">
        <input type="checkbox" class="mt-0.5" checked={purge()} disabled={settled()} onChange={(e) => setPurge(e.currentTarget.checked)} />
        <span>{purgeLabel(count())}</span>
      </label>
      <Show when={loading()}>
        <p class="mt-2 text-neutral-500">Looking for similar memories…</p>
      </Show>
      <Show when={extras().length}>
        <p class="mt-2 text-neutral-500">Also matched (unchecked; tick to include):</p>
        <ul class="mt-1 space-y-1">
          <For each={extras()}>
            {(c) => (
              <li>
                <label class="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={!!ticked()[c.id]}
                    disabled={settled()}
                    onChange={() => setTicked((m) => ({ ...m, [c.id]: !m[c.id] }))}
                  />
                  <span class="whitespace-pre-wrap">{c.content}</span>
                </label>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Dialog>
  )
}

export function RecallView(props: { result: RecallResult | undefined }) {
  const [more, setMore] = createSignal<{ base: RecallResult; value?: RecallOk; loading: boolean; note: string }>()
  const current = () => {
    const m = more()
    return m && m.base === props.result ? m : undefined
  }
  const failed = () => (props.result && props.result.ok === false ? props.result : undefined)
  const ok = (): RecallOk | undefined => {
    const r = props.result
    return current()?.value ?? (r && r.ok ? r : undefined)
  }
  const loadMore = async () => {
    const base = props.result
    const cur = ok()
    const req = cur ? nextRecallRequest(cur) : undefined
    if (!base || !cur || !req || current()?.loading) return
    let value = current()?.value
    setMore({ base, value, loading: true, note: "" })
    let note = ""
    try {
      const next = await fetchRecall(req)
      if (!next.ok) note = next.error
      else {
        const merged = mergeRecall(cur, next)
        value = merged.result
        if (!merged.added) note = "No further source messages could be loaded."
      }
    } catch (e) {
      note = e instanceof Error ? e.message : String(e)
    }
    if (props.result === base) setMore({ base, value, loading: false, note })
  }
  return (
    <Show when={props.result} fallback={<p class="text-neutral-500">Select a result to preview the exact source.</p>}>
      <Show when={failed()}>{(f) => <p class="text-red-700 dark:text-red-400">{f().error}</p>}</Show>
      <Show when={ok()}>
        {(r) => (
          <div class="space-y-2">
            <p class="text-[11px] text-neutral-500">{r().guarantee}</p>
            <For each={r().messages}>
              {(m) => {
                const reverted = m.status === "reverted" || m.status === "removed"
                return (
                  <div class="rounded border border-neutral-200 p-2 dark:border-neutral-800">
                    <p class="text-[11px] text-neutral-500">
                      #{m.seq} {m.role}
                      {m.agent ? ` · ${m.agent}` : ""}
                      {reverted ? " · reverted" : ""}
                    </p>
                    <For each={m.parts}>
                      {(p) => (
                        <p class={`whitespace-pre-wrap ${p.forgotten ? "text-neutral-400 line-through" : ""} ${reverted ? "opacity-70" : ""}`}>
                          {p.text}
                          <Show when={p.forgotten}>
                            <span class="ml-1 text-[10px] tracking-wide uppercase">forgotten</span>
                          </Show>
                          <Show when={p.redactions > 0}>
                            <span class="ml-1 text-[10px] tracking-wide text-amber-700 uppercase dark:text-amber-300">redacted</span>
                          </Show>
                          <Show when={p.omitted > 0}>
                            <span class="ml-1 text-[10px] tracking-wide uppercase">omitted</span>
                          </Show>
                          <Show when={p.truncated}>
                            <span class="ml-1 text-[10px] tracking-wide text-amber-700 dark:text-amber-300">(truncated)</span>
                          </Show>
                        </p>
                      )}
                    </For>
                  </div>
                )
              }}
            </For>
            <Show when={r().truncated}>
              <div class="rounded border border-dashed border-amber-400 p-2 text-[11px] text-amber-900 dark:border-amber-700 dark:text-amber-200" role="note">
                <p>
                  Truncated —{" "}
                  {r().nextCursor
                    ? `more source messages follow #${r().messages[r().messages.length - 1]?.seq ?? r().toSeq}.`
                    : hasTruncatedPart(r().messages)
                      ? "some long messages were shortened to fit (marked truncated)."
                      : "the rest of this source was not returned."}
                </p>
                <Show when={nextRecallRequest(r())}>
                  <Button class="mt-1" disabled={!!current()?.loading} onClick={() => void loadMore()}>
                    {current()?.loading ? "Loading…" : "Load more"}
                  </Button>
                </Show>
              </div>
            </Show>
            <Show when={current()?.note}>
              <p class="text-[11px] text-red-700 dark:text-red-400">{current()?.note}</p>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  )
}

export function SearchPanel(props: {
  open: boolean
  onClose: () => void
  session?: string
  hits: SearchHit[]
  query: string
  onQuery: (q: string) => void
  onSearch: () => void
  loading?: boolean
  error?: string
  recall?: RecallResult
  onPick: (hit: SearchHit) => void
}) {
  return (
    <Dialog open={props.open} title="Search memory" onClose={props.onClose} wide>
      <LiveFeedback feedback={props.error ? { tone: "error", text: props.error } : undefined} />
      <form
        class="mb-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          props.onSearch()
        }}
      >
        <TextInput label="Search memory" placeholder="Search memory" value={props.query} onInput={props.onQuery} autofocus />
        <Button kind="primary" type="submit">
          Search
        </Button>
      </form>
      <div class="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden md:grid-cols-2">
        <ul class="max-h-[50vh] overflow-auto border-b border-neutral-200 md:border-r md:border-b-0 dark:border-neutral-800">
          <For each={props.hits} fallback={<li class="p-3 text-neutral-500">{props.loading ? "Searching…" : "No results"}</li>}>
            {(h) => (
              <li>
                <button type="button" class="w-full px-2 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900" onClick={() => props.onPick(h)}>
                  <p class="whitespace-pre-wrap">{h.row.content}</p>
                  <p class="text-[11px] text-neutral-500">
                    {observedAgo(h.row.observed_at)} · {h.row.scope_kind}
                    {h.score ? ` · ${h.score.toFixed(2)}` : ""}
                  </p>
                </button>
              </li>
            )}
          </For>
        </ul>
        <div class="max-h-[50vh] overflow-auto p-1">
          <RecallView result={props.recall} />
        </div>
      </div>
    </Dialog>
  )
}

export function matchesScope(row: ObservationRow, scope: string): boolean {
  if (scope === "all" || !scope) return true
  return row.scope_kind === scope
}

/** Recall of a row, read as the row's own session/project; `fallbackSession` covers rows without a session. */
export async function loadRecall(row: ObservationRow, fallbackSession?: string): Promise<RecallResult> {
  return fetchRecall(recallRequestFor(row, fallbackSession))
}
