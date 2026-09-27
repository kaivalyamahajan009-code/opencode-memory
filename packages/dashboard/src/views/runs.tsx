import { For, createResource } from "solid-js"
import { fetchJobs, fetchOperations, fetchTimeline, retryChunk, retryQuarantined } from "../api"
import { formatTokens, formatUsd, age } from "../format"
import { useDash } from "../store"
import { Button } from "../ui"

export default function Runs() {
  const dash = useDash()
  const [ops, { refetch: refetchOps }] = createResource(() => fetchOperations(80))
  const [jobs, { refetch: refetchJobs }] = createResource(() => fetchJobs())
  const session = () => dash.host().sessionID
  const [tl, { refetch: refetchTl }] = createResource(session, (id) => (id ? fetchTimeline(id) : Promise.resolve(undefined)))

  const refresh = () => {
    void refetchOps()
    void refetchJobs()
    void refetchTl()
  }

  const quarantined = () => (tl.latest?.chunks ?? []).filter((c) => c.state === "quarantined")

  const err = (e: unknown) => dash.toasts.error(e instanceof Error ? e.message : String(e))

  return (
    <div class="space-y-4 p-4">
      <div class="flex items-center justify-between">
        <h1 class="text-[15px] font-semibold">Runs</h1>
        <Button
          onClick={async () => {
            try {
              const { n } = await retryQuarantined(session() || undefined)
              dash.toasts.ok(`Retried ${n} quarantined chunk(s)`)
              refresh()
            } catch (e) {
              err(e)
            }
          }}
        >
          Retry quarantined
        </Button>
      </div>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Operations</h2>
        <table class="w-full text-left">
          <thead>
            <tr class="text-[11px] text-neutral-500">
              <th class="py-1">Kind</th>
              <th>Status</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Error</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            <For each={ops.latest ?? []}>
              {(op) => (
                <tr class="border-t border-neutral-200 dark:border-neutral-800">
                  <td class="py-1">{op.kind}</td>
                  <td>{op.status}</td>
                  <td>{formatTokens(op.input_tokens + op.output_tokens)}</td>
                  <td>{formatUsd(op.cost)}</td>
                  <td class="max-w-[16rem] truncate" title={op.error ?? ""}>
                    {op.error || "—"}
                  </td>
                  <td>{age(op.started_at)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Jobs</h2>
        <ul>
          <For each={jobs.latest ?? []} fallback={<li class="text-neutral-500">No jobs.</li>}>
            {(j) => (
              <li class="py-1">
                {j.key} · {j.kind} · {j.state}
                {j.error ? ` · ${j.error}` : ""}
              </li>
            )}
          </For>
        </ul>
      </section>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Quarantined chunks</h2>
        <For each={quarantined()} fallback={<p class="text-neutral-500">None in this session.</p>}>
          {(c) => (
            <div class="flex items-center justify-between gap-2 py-1">
              <span>
                {c.id} seq {c.start_seq}–{c.end_seq} · {c.error || c.state}
              </span>
              <Button
                onClick={async () => {
                  try {
                    await retryChunk(c.id)
                    refresh()
                  } catch (e) {
                    err(e)
                  }
                }}
              >
                Retry
              </Button>
            </div>
          )}
        </For>
      </section>
    </div>
  )
}
