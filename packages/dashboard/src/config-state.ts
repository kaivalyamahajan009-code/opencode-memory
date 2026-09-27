import { errorMessage } from "./errors"

/**
 * Config baseline with a save generation: a GET that started before a save can neither replace
 * the saved value nor report an error over it.
 */
export function createConfigState<C>() {
  let value: C | undefined
  let error: string | undefined
  let loaded = false
  let generation = 0
  return {
    /** Call when a GET starts; pass the result to resolve/reject. */
    begin: () => generation,
    resolve(gen: number, cfg: C) {
      if (gen !== generation) return
      value = cfg
      loaded = true
      error = undefined
    },
    reject(gen: number, e: unknown) {
      if (gen !== generation) return
      error = errorMessage(e)
    },
    /** A saved config (e.g. what POST /api/config returned) becomes the baseline immediately. */
    apply(cfg: C) {
      generation++
      value = cfg
      loaded = true
      error = undefined
    },
    get: () => ({ value, error, loaded }),
  }
}
