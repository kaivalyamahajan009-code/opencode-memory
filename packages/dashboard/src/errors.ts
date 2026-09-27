import { ApiError } from "./api-unwrap"

const CHUNK_LOAD =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk \S+ failed/i

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The server's reason for a refused restore (e.g. an unmarked or empty backup), shown as-is. */
export function restoreErrorText(err: unknown): string {
  const msg = errorMessage(err)
  if (err instanceof ApiError && err.status >= 500) return `Restore failed: ${msg}. Check the OpenCode log for details.`
  return `Restore failed: ${msg}`
}

export const INSTRUCTION_REFUSED_TEXT = "Memories can't contain instructions to the assistant."
export const FORGOTTEN_SESSION_TEXT = "This session was forgotten and can't be re-included."

function sentence(msg: string): string {
  return msg ? msg[0]!.toUpperCase() + msg.slice(1) : msg
}

/**
 * Why a remember/edit/supersede was refused: 400 for instruction-like or invalid content, 409 when
 * the session was forgotten, excluded or deleted (or the text was forgotten before).
 */
export function writeErrorText(err: unknown): string {
  const msg = errorMessage(err)
  if (!(err instanceof ApiError)) return msg
  if (err.status === 400 && /instruction/i.test(msg)) return INSTRUCTION_REFUSED_TEXT
  if (err.status === 409 && /session was forgotten/i.test(msg)) return "This session was forgotten, so nothing more can be stored from it."
  if (err.status === 409 && /session is excluded/i.test(msg)) return "This session is excluded from memory. Include it again in Settings to add memories to it."
  if (err.status === 409 && /session was deleted/i.test(msg)) return "This session was deleted, so memories can't be added to it."
  return sentence(msg)
}

/** A refused pause/exclude toggle; un-excluding a forgotten session is 409. */
export function sessionFlagErrorText(err: unknown): string {
  const msg = errorMessage(err)
  if (err instanceof ApiError && err.status === 409 && /forgotten/i.test(msg)) return FORGOTTEN_SESSION_TEXT
  return sentence(msg)
}

/** A lazy view chunk failed to load (e.g. the build changed under an open tab); Solid caches that failure, so only a reload helps. */
export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false
  if ((err as { name?: unknown }).name === "ChunkLoadError") return true
  return CHUNK_LOAD.test(errorMessage(err))
}
