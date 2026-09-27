export type PollScheduler = {
  /** Background tick: skipped while a request is in flight or when `canRun` is false. */
  tick: () => Promise<void>
  /** Forced fetch; if one is in flight, exactly one follow-up runs after it and this resolves then. */
  reload: () => Promise<void>
  /** Discards whatever is in flight (its result is never delivered). */
  reset: () => void
}

export function createPollScheduler<T>(opts: {
  fn: () => Promise<T>
  canRun: () => boolean
  key?: () => string
  onData: (value: T) => void
  onError: (error: unknown) => void
  onSettled?: () => void
}): PollScheduler {
  let inFlight = false
  let queued = false
  let queuedForced = false
  let epoch = 0
  let waiters: (() => void)[] = []

  const run = async (): Promise<void> => {
    inFlight = true
    const keyAt = opts.key?.()
    const epochAt = epoch
    const stale = () => epochAt !== epoch || (opts.key !== undefined && opts.key() !== keyAt)
    try {
      const value = await opts.fn()
      if (stale()) queued = true
      else opts.onData(value)
    } catch (e) {
      if (stale()) queued = true
      else opts.onError(e)
    } finally {
      inFlight = false
      opts.onSettled?.()
    }
    const done = waiters
    waiters = []
    if (queued) {
      const forced = queuedForced
      queued = false
      queuedForced = false
      await start(forced)
    }
    for (const w of done) w()
  }

  const start = (forced: boolean): Promise<void> => {
    if (inFlight) {
      if (!forced) return Promise.resolve()
      queued = true
      queuedForced = true
      return new Promise((resolve) => waiters.push(resolve))
    }
    if (!forced && !opts.canRun()) return Promise.resolve()
    return run()
  }

  return {
    tick: () => start(false),
    reload: () => start(true),
    reset: () => {
      epoch++
    },
  }
}
