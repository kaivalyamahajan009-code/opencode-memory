import { createResource, createSignal } from "solid-js"
import { For } from "solid-js"
import { decideReview, fetchReview } from "../api"
import { bulkableIds, bulkSummary, runBulk } from "../review-bulk"
import { isVaultConflict, reviewText } from "../review-kind"
import { useDash } from "../store"
import type { ReviewItem } from "../types"
import { Button } from "../ui"
import { ReviewList } from "../widgets"

export default function Review() {
  const dash = useDash()
  const [items, { refetch }] = createResource(() => fetchReview("open"))
  const [picked, setPicked] = createSignal<Record<string, boolean>>({})
  const [bulkBusy, setBulkBusy] = createSignal(false)
  const list = () => items.latest ?? []
  const bulkable = () => bulkableIds(list(), picked())

  const bulk = async (decision: "approve" | "reject") => {
    const ids = bulkable()
    if (!ids.length || bulkBusy()) return
    setBulkBusy(true)
    try {
      const r = await runBulk(ids, (id) => decideReview(id, decision))
      setPicked(Object.fromEntries(r.failed.map((f) => [f.id, true])))
      const msg = bulkSummary(decision, r)
      if (r.failed.length) dash.toasts.error(msg)
      else dash.toasts.ok(msg)
    } finally {
      setBulkBusy(false)
      void refetch()
      void dash.reload()
    }
  }

  const toggle = (it: ReviewItem) => setPicked((m) => ({ ...m, [it.id]: !m[it.id] }))

  return (
    <div class="p-4">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <h1 class="text-[15px] font-semibold">Review</h1>
        <Button onClick={() => void bulk("approve")} disabled={!bulkable().length || bulkBusy()}>
          Approve selected
        </Button>
        <Button kind="danger" onClick={() => void bulk("reject")} disabled={!bulkable().length || bulkBusy()}>
          Reject selected
        </Button>
      </div>
      <ul class="mb-3">
        <For each={list()}>
          {(it) => (
            <li>
              <label class="flex items-start gap-2 py-1">
                <ShowCheck it={it} checked={!!picked()[it.id]} onToggle={() => toggle(it)} />
                <span class="whitespace-pre-wrap">
                  {reviewText(it)}
                  {isVaultConflict(it) ? " (vault file conflict — excluded from bulk)" : ""}
                </span>
              </label>
            </li>
          )}
        </For>
      </ul>
      <ReviewList
        items={list()}
        onDone={() => {
          void refetch()
          void dash.reload()
        }}
        onError={(m) => dash.toasts.error(m)}
      />
    </div>
  )
}

function ShowCheck(props: { it: ReviewItem; checked: boolean; onToggle: () => void }) {
  if (isVaultConflict(props.it)) return null
  return <input type="checkbox" checked={props.checked} onChange={props.onToggle} aria-label={`Select ${props.it.id}`} />
}
