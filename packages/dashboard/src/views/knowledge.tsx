import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { approveTopic, fetchReview, fetchTopic, fetchTopics, rollbackTopic } from "../api"
import { SafeMarkdown } from "../markdown"
import { isVaultConflict } from "../review-kind"
import { useDash } from "../store"
import type { TopicDetail, TopicRow } from "../types"
import { Button, Select } from "../ui"
import { ReviewList } from "../widgets"

export default function Knowledge() {
  const dash = useDash()
  const [scope, setScope] = createSignal("")
  const [topics, { refetch }] = createResource(scope, (s) => fetchTopics(s || undefined))
  const [active, setActive] = createSignal<TopicRow | undefined>()
  const [detailError, setDetailError] = createSignal("")
  const [detail, { refetch: refetchDetail }] = createResource(
    () => active()?.id,
    async (id): Promise<TopicDetail | undefined> => {
      setDetailError("")
      try {
        return await fetchTopic(id)
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : String(e))
        return undefined
      }
    },
    { initialValue: undefined },
  )
  const shownDetail = () => {
    const d = detail.latest
    return d && d.id === active()?.id ? d : undefined
  }
  const [review, { refetch: refetchReview }] = createResource(() => fetchReview("open"))
  const vault = createMemo(() => (review.latest ?? []).filter(isVaultConflict))
  const topicList = () => topics.latest ?? []

  const scopes = createMemo(() => {
    const keys = new Set(topicList().map((t) => t.scope_key))
    return ["", ...keys]
  })

  const onRef = (id: string) => {
    dash.toasts.ok(`Observation ${id}`)
  }

  return (
    <div class="flex h-full min-h-0">
      <div class="w-[16rem] shrink-0 overflow-auto border-r border-neutral-200 p-3 dark:border-neutral-800">
        <h1 class="mb-2 text-[15px] font-semibold">Knowledge</h1>
        <Select
          label="Scope"
          value={scope()}
          onChange={setScope}
          options={scopes().map((s) => ({ value: s, label: s || "All scopes" }))}
        />
        <ul class="mt-2">
          <For each={topicList()} fallback={<li class="text-neutral-500">No topics yet.</li>}>
            {(t) => (
              <li>
                <button
                  type="button"
                  class={`block w-full px-1 py-1 text-left ${active()?.id === t.id ? "font-medium" : ""}`}
                  onClick={() => setActive(t)}
                >
                  <span class="block truncate">{t.title}</span>
                  <span class="text-[11px] text-neutral-500">{t.scope_key}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="min-w-0 flex-1 overflow-auto p-4">
        <Show
          when={shownDetail()}
          fallback={
            <p class={detailError() ? "text-red-700 dark:text-red-400" : "text-neutral-500"}>
              {detailError() ? `Could not load this topic: ${detailError()}` : active() ? "Loading…" : "Select a topic."}
            </p>
          }
        >
          {(t) => (
            <div>
              <div class="mb-2 flex flex-wrap gap-2">
                <Button
                  onClick={async () => {
                    try {
                      await approveTopic(t().id)
                      dash.toasts.ok("Topic approved")
                      void refetch()
                      void refetchDetail()
                    } catch (e) {
                      dash.toasts.error(e instanceof Error ? e.message : String(e))
                    }
                  }}
                >
                  Approve generation
                </Button>
              </div>
              <SafeMarkdown source={t().body} onRef={onRef} />
              <h2 class="mt-4 text-[11px] font-semibold tracking-wide uppercase">Generations</h2>
              <ul>
                <For each={t().generations ?? []}>
                  {(g) => (
                    <li class="flex items-center justify-between gap-2 py-1">
                      <span>
                        gen {g.generation} · {g.actor} · {new Date(g.created_at).toLocaleString()}
                      </span>
                      <Button
                        onClick={async () => {
                          try {
                            await rollbackTopic(t().id, g.generation)
                            dash.toasts.ok("Rolled back")
                            void refetchDetail()
                          } catch (e) {
                            dash.toasts.error(e instanceof Error ? e.message : String(e))
                          }
                        }}
                      >
                        Rollback
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </Show>
        <Show when={vault().length}>
          <section class="mt-6">
            <h2 class="mb-2 text-[11px] font-semibold tracking-wide uppercase">Vault conflicts</h2>
            <p class="mb-2 text-[11px] text-neutral-500">Keep-file is not human approval of observations.</p>
            <ReviewList
              items={vault()}
              onDone={() => {
                void refetchReview()
                void dash.reload()
              }}
              onError={(m) => dash.toasts.error(m)}
            />
          </section>
        </Show>
      </div>
    </div>
  )
}
