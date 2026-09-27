import { For, Show, createResource } from "solid-js"
import { fetchResearch } from "../api"
import { useDash } from "../store"

export default function Research() {
  const dash = useDash()
  const [data] = createResource(
    () => dash.status() && dash.workspace(),
    (ws) => fetchResearch(ws || undefined),
  )
  const payload = () => data.latest

  return (
    <div class="space-y-4 p-4">
      <h1 class="text-[15px] font-semibold">Research</h1>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Claims</h2>
        <table class="w-full text-left">
          <thead>
            <tr class="text-[11px] text-neutral-500">
              <th class="py-1">Statement</th>
              <th>Status</th>
              <th>Support</th>
              <th>Contest</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            <For each={payload()?.claims ?? []} fallback={<tr><td class="py-2 text-neutral-500" colSpan={5}>No claims yet.</td></tr>}>
              {(c) => (
                <tr class="border-t border-neutral-200 align-top dark:border-neutral-800">
                  <td class="py-1 pr-2 whitespace-pre-wrap">{c.statement}</td>
                  <td>{c.status}</td>
                  <td>{c.support.length}</td>
                  <td>{c.contradict.length}</td>
                  <td>{c.confidence.toFixed(2)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Source library</h2>
        <ul>
          <For each={payload()?.sources ?? []} fallback={<li class="text-neutral-500">No sources indexed.</li>}>
            {(s) => (
              <li class="py-1">
                <span class="whitespace-pre-wrap">{s.title || s.doi || s.url || s.id}</span>
                <span class="ml-2 text-neutral-500">{s.evidence_count ?? 0} evidence</span>
              </li>
            )}
          </For>
        </ul>
      </section>
      <section>
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide uppercase">Conflict report</h2>
        <For each={payload()?.conflicts ?? []} fallback={<p class="text-neutral-500">No contested claims.</p>}>
          {(c) => (
            <div class="mb-2 rounded border border-neutral-200 p-2 dark:border-neutral-800">
              <p class="whitespace-pre-wrap">{c.statement}</p>
              <p class="text-[11px] text-neutral-500">
                {c.support.length} for / {c.contradict.length} against
              </p>
              <Show when={c.support[0]?.quotation}>
                <p class="text-neutral-600 dark:text-neutral-300">Support: {c.support[0]!.quotation}</p>
              </Show>
              <Show when={c.contradict[0]?.quotation}>
                <p class="text-neutral-600 dark:text-neutral-300">Against: {c.contradict[0]!.quotation}</p>
              </Show>
            </div>
          )}
        </For>
      </section>
    </div>
  )
}
