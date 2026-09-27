import { For, Show, createResource } from "solid-js"
import { fetchLearning, fetchOperations, fetchReview } from "../api"
import { formatTokens, formatUsd, age } from "../format"
import { deriveMemoryState, statusTitle } from "../status"
import { useDash } from "../store"
import { Button, Gauge } from "../ui"
import { MemoryGauges, StatusPill } from "../widgets"

export default function Overview() {
  const dash = useDash()
  const [ops] = createResource(() => fetchOperations(8))
  const [review] = createResource(() => fetchReview("open"))
  const [learning] = createResource(
    () => dash.status() && dash.workspace(),
    (ws) => fetchLearning(ws || undefined),
  )
  const state = () => deriveMemoryState(dash.status()?.global, dash.status()?.session)
  const g = () => dash.status()?.global
  return (
    <div class="space-y-4 p-4">
      <div class="flex items-center justify-between">
        <h1 class="text-[15px] font-semibold">Overview</h1>
        <Show when={g()}>
          <StatusPill
            state={state()}
            title={statusTitle(state(), g(), dash.status()?.session)}
            onResume={g()?.paused ? () => void dash.pause() : undefined}
          />
        </Show>
      </div>
      <Show when={g()}>
        {(global) => (
          <MemoryGauges
            global={global()}
            session={dash.status()?.session}
            reflectThreshold={dash.config()?.reflect?.thresholdTokens ?? 40_000}
            generation={undefined}
            onPause={() => void dash.pause()}
          />
        )}
      </Show>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">Instances</h2>
        <ul class="divide-y divide-neutral-200 rounded border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          <For each={g()?.instances ?? []} fallback={<li class="p-2 text-neutral-500">No connected OpenCode instances.</li>}>
            {(inst) => (
              <li class="px-2 py-1.5">
                <p class="truncate">{inst.directory}</p>
                <p class="text-[11px] text-neutral-500">
                  pid {inst.pid} · {age(inst.heartbeat_at)}
                </p>
              </li>
            )}
          </For>
        </ul>
      </section>
      <section class="grid gap-3 md:grid-cols-2">
        <div>
          <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">
            Needs review ({(review.latest ?? []).length || g()?.reviewOpen || 0})
          </h2>
          <p class="text-neutral-500">Open the Review view to approve, edit, or reject.</p>
        </div>
        <div>
          <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">Due reviews</h2>
          <For each={learning.latest?.due ?? []} fallback={<p class="text-neutral-500">No concepts due.</p>}>
            {(d) => (
              <p>
                {d.name} · due {age(d.due_at)}
              </p>
            )}
          </For>
        </div>
      </section>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">Recent runs</h2>
        <ul class="divide-y divide-neutral-200 rounded border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          <For each={ops.latest ?? []} fallback={<li class="p-2 text-neutral-500">No operations yet.</li>}>
            {(op) => (
              <li class="flex justify-between gap-2 px-2 py-1.5">
                <span>
                  {op.kind} · {op.status}
                  {op.error ? ` · ${op.error}` : ""}
                </span>
                <span class="tabular-nums text-neutral-500">
                  {formatTokens(op.input_tokens + op.output_tokens)} · {formatUsd(op.cost)}
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
      <Show when={g()}>
        <Gauge
          label="Daily $"
          value={g()!.usage.costUsd}
          max={g()!.cap.usd || 1}
          display={`${formatUsd(g()!.usage.costUsd)} / ${formatUsd(g()!.cap.usd)}`}
        />
      </Show>
      <Button onClick={() => void dash.pause()}>{g()?.paused ? "Resume memory" : "Pause memory"}</Button>
    </div>
  )
}
