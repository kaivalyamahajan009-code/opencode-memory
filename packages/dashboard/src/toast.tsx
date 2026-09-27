import { For, createSignal } from "solid-js"

export type ToastItem = { id: number; kind: "error" | "ok"; text: string }

export function createToasts() {
  const [items, setItems] = createSignal<ToastItem[]>([])
  let n = 0
  const push = (kind: ToastItem["kind"], text: string) => {
    const id = ++n
    setItems((xs) => [...xs, { id, kind, text }])
    window.setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 5000)
  }
  return {
    items,
    error: (text: string) => push("error", text),
    ok: (text: string) => push("ok", text),
  }
}

export function ToastHost(props: { items: ToastItem[] }) {
  return (
    <div class="pointer-events-none fixed right-2 bottom-2 z-50 flex w-[min(20rem,calc(100%-1rem))] flex-col gap-1" aria-live="polite">
      <For each={props.items}>
        {(t) => (
          <div
            class={`pointer-events-auto rounded border px-2 py-1.5 text-[12px] shadow ${
              t.kind === "error"
                ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
                : "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900"
            }`}
          >
            {t.text}
          </div>
        )}
      </For>
    </div>
  )
}
