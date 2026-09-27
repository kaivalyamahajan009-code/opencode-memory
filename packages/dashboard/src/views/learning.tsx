import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { fetchLearning, fetchObservations } from "../api"
import { learningWorkspace } from "../learning-scope"
import { renderMermaid } from "../mermaid"
import { sanitizeSvg, svgBlobUrl, UNSUPPORTED_SVG } from "../sanitize"
import { useDash } from "../store"
import { age } from "../format"

export default function Learning() {
  const dash = useDash()
  const scope = createMemo(() => learningWorkspace(dash.workspace()))
  const [data] = createResource(
    () => (dash.status() ? scope().workspace : undefined),
    (ws) => fetchLearning(ws),
  )
  const [mis] = createResource(
    () => (dash.status() ? scope().workspace : undefined),
    (ws) => fetchObservations({ kinds: "misconception", workspace: ws, limit: 50 }),
  )
  const [mapUrl, setMapUrl] = createSignal<string>()
  const payload = () => data.latest

  const source = createMemo(() => {
    const concepts = payload()?.concepts ?? []
    if (!concepts.length) return ""
    const groups = new Map<string, string[]>()
    for (const c of concepts) {
      const list = groups.get(c.level) ?? []
      list.push(`    ${idOf(c.id)}["${esc(c.name)}"]`)
      groups.set(c.level, list)
    }
    const parts = ["flowchart TB"]
    for (const [level, nodes] of groups) {
      parts.push(`  subgraph ${idOf(level)}["${esc(level)}"]`)
      parts.push(...nodes)
      parts.push("  end")
    }
    return parts.join("\n")
  })

  createEffect(() => {
    const src = source()
    let cancelled = false
    let created: string | undefined
    setMapUrl(undefined)
    if (!src) return
    void (async () => {
      try {
        const svg = await renderMermaid(src)
        if (cancelled) return
        const cleaned = sanitizeSvg(svg)
        if (!cleaned) throw new Error(UNSUPPORTED_SVG)
        if (cancelled) return
        created = svgBlobUrl(cleaned)
        if (cancelled) {
          URL.revokeObjectURL(created)
          return
        }
        setMapUrl(created)
      } catch (e) {
        if (!cancelled) dash.toasts.error(e instanceof Error ? e.message : String(e))
      }
    })()
    onCleanup(() => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
    })
  })

  onCleanup(() => {
    const u = mapUrl()
    if (u) URL.revokeObjectURL(u)
  })

  return (
    <div class="space-y-4 p-4">
      <div>
        <h1 class="text-[15px] font-semibold">Learning</h1>
        <p class="text-[11px] text-neutral-500">
          Workspace: {scope().workspace}
          {scope().fallback ? " (learning progress is tracked per workspace; pick one in the sidebar to switch)" : ""}
        </p>
      </div>
      <Show when={mapUrl()}>
        <figure>
          <figcaption class="mb-1 text-[11px] text-neutral-500">Concept map</figcaption>
          <img src={mapUrl()} alt="Concept map" class="max-h-80 w-full object-contain" />
        </figure>
      </Show>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Concepts</h2>
        <table class="w-full text-left">
          <thead>
            <tr class="text-[11px] text-neutral-500">
              <th class="py-1">Name</th>
              <th>Level</th>
              <th>Independent</th>
              <th>Assisted</th>
              <th>Incorrect</th>
              <th>Misconceptions</th>
            </tr>
          </thead>
          <tbody>
            <For each={payload()?.concepts ?? []}>
              {(c) => (
                <tr class="border-t border-neutral-200 dark:border-neutral-800">
                  <td class="py-1">{c.name}</td>
                  <td>{c.level}</td>
                  <td>{c.independentCorrect}</td>
                  <td>{c.assisted}</td>
                  <td>{c.incorrect}</td>
                  <td>{c.openMisconceptions}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Review calendar</h2>
        <For each={payload()?.calendar ?? []} fallback={<p class="text-neutral-500">No scheduled reviews.</p>}>
          {(d) => (
            <p>
              {d.date}: {d.count}
            </p>
          )}
        </For>
      </section>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Misconceptions</h2>
        <For each={mis.latest ?? []} fallback={<p class="text-neutral-500">None open.</p>}>
          {(o) => (
            <p class="whitespace-pre-wrap">
              {o.content} <span class="text-neutral-500">({age(o.observed_at)})</span>
            </p>
          )}
        </For>
      </section>
    </div>
  )
}

function idOf(s: string): string {
  return `n${s.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "x"}`
}

function esc(s: string): string {
  return s.replace(/"/g, "'")
}
