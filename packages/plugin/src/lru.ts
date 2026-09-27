/** Bounded LRU map; oldest keys are evicted after `max` entries. */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>()

  constructor(readonly max: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const v = this.map.get(key)!
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
