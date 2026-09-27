/**
 * Age-based cache freshness with explicit invalidation. A value fetched by a request that started
 * before invalidate() is stored as stale, so the next poll fetches again.
 */
export function createFreshness(maxAgeMs: number) {
  let epoch = 0
  let storedEpoch = -1
  let storedAt = 0
  return {
    invalidate() {
      epoch++
    },
    /** Call when a fetch starts; pass the value to store() when it lands. */
    begin: () => epoch,
    want: (now: number) => storedEpoch !== epoch || now - storedAt > maxAgeMs,
    store(startedAt: number, now: number) {
      storedEpoch = startedAt
      storedAt = now
    },
  }
}

export type Freshness = ReturnType<typeof createFreshness>
