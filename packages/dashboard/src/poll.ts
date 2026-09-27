import { createSignal, onCleanup } from "solid-js"
import { ApiError } from "./api-unwrap"
import { createPollScheduler } from "./poll-scheduler"

export function createPoll<T>(opts: {
  fn: () => Promise<T>
  intervalMs?: number
  paused?: () => boolean
  key?: () => string
}) {
  const intervalMs = opts.intervalMs ?? 3000
  const [data, setData] = createSignal<T | undefined>(undefined)
  const [error, setError] = createSignal<ApiError | undefined>(undefined)
  const [loading, setLoading] = createSignal(true)
  let intersecting = true

  const visible = () => document.visibilityState === "visible" && intersecting && !opts.paused?.()

  const scheduler = createPollScheduler<T>({
    fn: opts.fn,
    canRun: visible,
    key: opts.key,
    onData: (next) => {
      setData(() => next)
      setError(undefined)
    },
    onError: (e) => {
      if (e instanceof ApiError) setError(e)
      else setError(new ApiError(e instanceof Error ? e.message : String(e), -1))
    },
    onSettled: () => setLoading(false),
  })

  const tick = () => void scheduler.tick()

  tick()
  const id = window.setInterval(tick, intervalMs)
  const onVis = () => {
    if (document.visibilityState === "visible") tick()
  }
  document.addEventListener("visibilitychange", onVis)

  const io = new IntersectionObserver((entries) => {
    intersecting = entries.some((e) => e.isIntersecting)
    if (intersecting) tick()
  })
  io.observe(document.documentElement)

  onCleanup(() => {
    window.clearInterval(id)
    document.removeEventListener("visibilitychange", onVis)
    io.disconnect()
  })

  return {
    data,
    error,
    loading,
    reload: () => scheduler.reload(),
    /** Drops data from the previous key and discards anything in flight. */
    reset: () => {
      scheduler.reset()
      setData(undefined)
      setError(undefined)
      setLoading(true)
    },
    mutate: (fn: (prev: T | undefined) => T | undefined) => setData((prev) => fn(prev)),
  }
}
