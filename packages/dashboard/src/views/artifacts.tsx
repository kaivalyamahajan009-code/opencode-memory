import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { fetchArtifact, fetchArtifacts } from "../api"
import { renderMermaid } from "../mermaid"
import { sanitizeSvg, svgBlobUrl, UNSUPPORTED_SVG } from "../sanitize"
import { useDash } from "../store"
import type { ArtifactRow } from "../types"

export default function Artifacts() {
  const dash = useDash()
  const [list] = createResource(
    () => dash.status() && dash.workspace(),
    (ws) => fetchArtifacts(ws || undefined),
  )
  const [active, setActive] = createSignal<ArtifactRow | undefined>()
  const [url, setUrl] = createSignal<string>()
  const [title, setTitle] = createSignal("")
  const [retained, setRetained] = createSignal(true)
  const [error, setError] = createSignal("")

  createEffect(() => {
    const row = active()
    let cancelled = false
    let created: string | undefined
    setUrl(undefined)
    setError("")
    setRetained(true)
    if (!row) return
    setTitle(row.title || row.path)
    void (async () => {
      try {
        const a = await fetchArtifact(row.id)
        if (cancelled) return
        setTitle(a.title || row.title || row.path)
        if (a.content == null) {
          setRetained(false)
          return
        }
        let svg = a.content
        if (row.kind === "mermaid") svg = await renderMermaid(a.content)
        if (cancelled) return
        const cleaned = sanitizeSvg(svg)
        if (!cleaned) throw new Error(UNSUPPORTED_SVG)
        created = svgBlobUrl(cleaned)
        if (cancelled) {
          URL.revokeObjectURL(created)
          return
        }
        setUrl(created)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    onCleanup(() => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
    })
  })

  onCleanup(() => {
    const u = url()
    if (u) URL.revokeObjectURL(u)
  })

  return (
    <div class="p-4">
      <h1 class="mb-3 text-[15px] font-semibold">Artifacts</h1>
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <For each={list.latest ?? []} fallback={<p class="text-neutral-500">No diagrams indexed.</p>}>
          {(a) => (
            <button
              type="button"
              class="rounded border border-neutral-200 p-2 text-left hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-900"
              onClick={() => setActive(a)}
            >
              <p class="truncate font-medium">{a.title || a.path}</p>
              <p class="text-[11px] text-neutral-500">{a.kind}</p>
            </button>
          )}
        </For>
      </div>
      <Show when={active()}>
        <figure class="mt-4">
          <figcaption class="mb-1 text-[13px]">{title()}</figcaption>
          <Show when={!retained()}>
            <p class="text-neutral-500">content not retained</p>
          </Show>
          <Show when={error()}>
            <p class="text-red-700 dark:text-red-400">Could not render this artifact: {error()}</p>
          </Show>
          <Show when={url()}>
            <img src={url()} alt={title()} class="max-h-[28rem] w-full object-contain" />
          </Show>
          <Show when={retained() && !url() && !error()}>
            <p class="text-neutral-500">Rendering…</p>
          </Show>
        </figure>
      </Show>
    </div>
  )
}
