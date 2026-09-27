import { For, createSignal } from "solid-js"
import { fetchSearch, unwrapHits } from "../api"
import { observedAgo } from "../format"
import { useDash } from "../store"
import type { RecallResult, SearchHit } from "../types"
import { Button, TextInput } from "../ui"
import { RecallView, loadRecall } from "../widgets"

export default function SearchView() {
  const dash = useDash()
  const [query, setQuery] = createSignal("")
  const [hits, setHits] = createSignal<SearchHit[]>([])
  const [recall, setRecall] = createSignal<RecallResult | undefined>()
  const [busy, setBusy] = createSignal(false)
  let searchGen = 0
  let recallGen = 0

  const run = async () => {
    const gen = ++searchGen
    recallGen++
    setBusy(true)
    setRecall(undefined)
    try {
      const data = await fetchSearch(query(), {
        session: dash.host().sessionID || undefined,
        history: 1,
        limit: 40,
      })
      if (gen !== searchGen) return
      setHits(unwrapHits(data))
    } catch (e) {
      if (gen !== searchGen) return
      dash.toasts.error(e instanceof Error ? e.message : String(e))
    } finally {
      if (gen === searchGen) setBusy(false)
    }
  }

  const pick = async (hit: SearchHit) => {
    const gen = ++recallGen
    try {
      const result = await loadRecall(hit.row, dash.host().sessionID || undefined)
      if (gen !== recallGen) return
      setRecall(result)
    } catch (e) {
      if (gen !== recallGen) return
      setRecall({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col p-4">
      <h1 class="mb-2 text-[15px] font-semibold">Search</h1>
      <form
        class="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <TextInput label="Hybrid search" placeholder="Hybrid search" value={query()} onInput={setQuery} />
        <Button kind="primary" type="submit" disabled={busy()}>
          Search
        </Button>
      </form>
      <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-2">
        <ul class="overflow-auto rounded border border-neutral-200 dark:border-neutral-800">
          <For each={hits()} fallback={<li class="p-3 text-neutral-500">{busy() ? "Searching…" : "No results"}</li>}>
            {(h) => (
              <li>
                <button type="button" class="w-full px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900" onClick={() => void pick(h)}>
                  <p class="whitespace-pre-wrap">{h.row.content}</p>
                  <p class="text-[11px] text-neutral-500">
                    {observedAgo(h.row.observed_at)} · {h.row.scope_kind}
                  </p>
                </button>
              </li>
            )}
          </For>
        </ul>
        <div class="overflow-auto rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <RecallView result={recall()} />
        </div>
      </div>
    </div>
  )
}
