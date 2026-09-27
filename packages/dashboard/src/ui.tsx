import { ErrorBoundary, For, Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
import { errorMessage, isChunkLoadError } from "./errors"

export type FeedbackTone = "ok" | "warn" | "error"
export type Feedback = { tone: FeedbackTone; text: string }

/**
 * Inline feedback for modal dialogs (toasts render beneath a showModal() backdrop). The polite
 * status region stays mounted so updates are announced; errors are inserted as alerts.
 */
export function LiveFeedback(props: { feedback?: Feedback }) {
  const cls = (tone: FeedbackTone) =>
    tone === "error"
      ? "mb-2 rounded border border-red-300 bg-red-50 p-2 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
      : tone === "warn"
        ? "mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        : "mb-2 rounded border border-neutral-300 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-950"
  return (
    <>
      <div role="status" aria-live="polite">
        <Show when={props.feedback && props.feedback.tone !== "error" ? props.feedback : undefined}>
          {(f) => <p class={cls(f().tone)}>{f().text}</p>}
        </Show>
      </div>
      <Show when={props.feedback?.tone === "error" ? props.feedback : undefined}>
        {(f) => (
          <p role="alert" class={cls("error")}>
            {f().text}
          </p>
        )}
      </Show>
    </>
  )
}

export function Button(props: {
  children: JSX.Element
  onClick?: () => void
  disabled?: boolean
  kind?: "default" | "primary" | "danger" | "ghost"
  type?: "button" | "submit"
  title?: string
  class?: string
}) {
  const kind = () => props.kind ?? "default"
  const cls = () =>
    [
      "inline-flex items-center justify-center gap-1 rounded px-2 py-1 text-[12px] leading-tight disabled:opacity-40",
      kind() === "primary" ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900" : "",
      kind() === "danger" ? "bg-red-700 text-white dark:bg-red-600" : "",
      kind() === "ghost" ? "hover:bg-neutral-200/80 dark:hover:bg-neutral-800" : "",
      kind() === "default" ? "border border-neutral-300 bg-white hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800" : "",
      props.class ?? "",
    ].join(" ")
  return (
    <button type={props.type ?? "button"} class={cls()} disabled={props.disabled} title={props.title} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

export function IconButton(props: { label: string; onClick?: () => void; children: JSX.Element; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      class="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-200/80 disabled:opacity-40 dark:hover:bg-neutral-800"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export function Chip(props: { active?: boolean; onClick?: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      class={`rounded-full border px-2 py-0.5 text-[11px] ${
        props.active
          ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
          : "border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      }`}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export function Banner(props: { kind?: "error" | "warn"; children: JSX.Element }) {
  return (
    <div
      class={`border-b px-3 py-1.5 text-[12px] ${
        props.kind === "warn"
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
          : "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
      }`}
      role="status"
    >
      {props.children}
    </div>
  )
}

export function Gauge(props: { label: string; value: number; max: number; display: string; hint?: string }) {
  const width = () => `${Math.max(0, Math.min(100, props.max <= 0 ? 0 : (props.value / props.max) * 100))}%`
  return (
    <div class="flex items-center gap-2">
      <span class="w-[5.5rem] shrink-0 truncate text-neutral-500 dark:text-neutral-400">{props.label}</span>
      <div
        class="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800"
        role="progressbar"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={props.max}
        aria-valuenow={Math.round(props.value)}
      >
        <div class="h-full rounded bg-neutral-700 dark:bg-neutral-300" style={{ width: width() }} />
      </div>
      <span class="w-[6.5rem] shrink-0 text-right tabular-nums text-neutral-600 dark:text-neutral-300" title={props.hint}>
        {props.display}
      </span>
    </div>
  )
}

/** Catches render/resource errors below it; resets on Retry or whenever `resetKey` changes. */
export function ViewBoundary(props: { children: JSX.Element; resetKey?: () => unknown }) {
  return (
    <ErrorBoundary
      fallback={(err: unknown, reset) => {
        console.error(err)
        if (props.resetKey) createEffect(on(props.resetKey, () => reset(), { defer: true }))
        const chunk = isChunkLoadError(err)
        return (
          <div class="m-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100" role="alert">
            <p class="font-medium">{chunk ? "This view could not be loaded" : "Something went wrong"}</p>
            <p class="mt-0.5 break-words opacity-80">
              {chunk ? "The dashboard was probably updated since this page opened." : errorMessage(err)}
            </p>
            <Show
              when={chunk}
              fallback={
                <Button class="mt-2" onClick={reset}>
                  Retry
                </Button>
              }
            >
              <Button class="mt-2" onClick={() => location.reload()}>
                Reload page
              </Button>
            </Show>
          </div>
        )
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}

export function EmptyState(props: { title: string; body?: string }) {
  return (
    <div class="px-3 py-8 text-center text-neutral-500 dark:text-neutral-400">
      <p class="font-medium text-neutral-700 dark:text-neutral-200">{props.title}</p>
      <Show when={props.body}>
        <p class="mt-1">{props.body}</p>
      </Show>
    </div>
  )
}

export function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="flex flex-col gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
      <span>{props.label}</span>
      {props.children}
    </label>
  )
}

export function Select(props: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  class?: string
}) {
  return (
    <label class={`inline-flex items-center gap-1 text-[11px] text-neutral-500 ${props.class ?? ""}`}>
      <span class="sr-only">{props.label}</span>
      <select
        class="rounded border border-neutral-300 bg-white px-1 py-0.5 text-[11px] dark:border-neutral-700 dark:bg-neutral-900"
        value={props.value}
        aria-label={props.label}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
      </select>
    </label>
  )
}

export function Dialog(props: {
  open: boolean
  title: string
  onClose: () => void
  children: JSX.Element
  footer?: JSX.Element
  wide?: boolean
}) {
  let ref: HTMLDialogElement | undefined
  createEffect(() => {
    const el = ref
    if (!el) return
    if (props.open && !el.open) el.showModal()
    if (!props.open && el.open) el.close()
  })
  return (
    <dialog
      ref={(el) => {
        ref = el
      }}
      class={
        props.wide
          ? "h-[min(90vh,40rem)] w-[min(48rem,calc(100vw-2rem))] rounded-lg border border-neutral-200 bg-white p-0 text-[12px] text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          : "w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-neutral-200 bg-white p-0 text-[12px] text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      }
      onClose={props.onClose}
    >
      <Show when={props.open}>
        <form class="flex h-full min-h-0 flex-col" onSubmit={(e) => e.preventDefault()}>
          <div class="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
            <h2 class="text-[13px] font-medium">{props.title}</h2>
            <IconButton label="Close" onClick={props.onClose}>
              <span aria-hidden="true">x</span>
            </IconButton>
          </div>
          <div class="min-h-0 flex-1 overflow-auto px-3 py-2">{props.children}</div>
          <Show when={props.footer}>
            <div class="flex justify-end gap-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">{props.footer}</div>
          </Show>
        </form>
      </Show>
    </dialog>
  )
}

export function TextInput(props: {
  value: string
  onInput: (v: string) => void
  placeholder?: string
  label?: string
  type?: string
  autofocus?: boolean
}) {
  return (
    <input
      class="w-full rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.label ?? props.placeholder}
      type={props.type ?? "text"}
      autofocus={props.autofocus}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  )
}

export function TextArea(props: { value: string; onInput: (v: string) => void; label?: string; rows?: number }) {
  return (
    <textarea
      class="w-full resize-y rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
      value={props.value}
      rows={props.rows ?? 4}
      aria-label={props.label}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  )
}

export function Menu(props: { label: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false)
  let wrap: HTMLDivElement | undefined
  const onDoc = (e: MouseEvent) => {
    if (wrap && !wrap.contains(e.target as Node)) setOpen(false)
  }
  onMount(() => document.addEventListener("mousedown", onDoc))
  onCleanup(() => document.removeEventListener("mousedown", onDoc))
  return (
    <div
      class="relative"
      ref={(el) => {
        wrap = el
      }}
      onFocusOut={(e) => {
        if (!wrap?.contains(e.relatedTarget as Node)) setOpen(false)
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setOpen(false)
          e.stopPropagation()
        }
      }}
    >
      <button
        type="button"
        aria-label={props.label}
        title={props.label}
        aria-haspopup="menu"
        aria-expanded={open()}
        class="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-200/80 disabled:opacity-40 dark:hover:bg-neutral-800"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true" class="text-[15px] leading-none">
          ...
        </span>
      </button>
      <Show when={open()}>
        <div role="menu" class="absolute right-0 z-30 mt-1 min-w-[11rem] rounded border border-neutral-200 bg-white py-1 shadow-md dark:border-neutral-700 dark:bg-neutral-900">
          <div onClick={() => setOpen(false)}>{props.children}</div>
        </div>
      </Show>
    </div>
  )
}

export function MenuItem(props: { onClick: () => void; children: JSX.Element; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      class={`block w-full px-3 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 ${props.danger ? "text-red-700 dark:text-red-400" : ""}`}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}
