import { realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, sep } from "node:path"

/** `\\server\share`, `//server/share` and `\\?\` device paths: opening them can leak credentials or hang. */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

/** Lexical containment (case-insensitive on Windows); `full === root` counts as inside. */
export function isInside(root: string, full: string): boolean {
  const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s)
  const rel = relative(fold(root), fold(full))
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Win32 `\\?\` long-path prefixes stripped (`\\?\UNC\` back to `\\`) so both sides of a containment check compare. */
export function plainPath(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`
  if (p.startsWith("\\\\?\\")) return p.slice(4)
  return p
}

/** Real path without the Win32 long-path prefix. */
export function realPath(p: string): string {
  return plainPath(realpathSync.native(p))
}

/**
 * Whether `target` (or, while it does not exist yet, its nearest existing ancestor) really is
 * inside the real `root`, after resolving symlinks and junctions. A local root never contains
 * a UNC/device path. Undefined when the root itself does not exist; false when the lexical
 * walk up leaves the root.
 */
export function realInside(root: string, target: string): boolean | undefined {
  let realRoot: string
  try {
    realRoot = realPath(root)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw e
  }
  for (let probe = target; ; ) {
    let real: string
    try {
      real = realPath(probe)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e
      const up = dirname(probe)
      if (up === probe || !isInside(root, up)) return false
      probe = up
      continue
    }
    return !(isUncPath(real) && !isUncPath(realRoot)) && isInside(realRoot, real)
  }
}
