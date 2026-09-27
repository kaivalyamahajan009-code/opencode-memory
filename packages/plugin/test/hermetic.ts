import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Import first in every test file: points each per-user location (memory config and data,
 * OpenCode config, home) at a throwaway dir so tests never read or write the developer's
 * real ~/.config/opencode-memory or OpenCode config.
 */
const g = globalThis as { __omTestHome?: string }

if (!g.__omTestHome) {
  const home = mkdtempSync(join(tmpdir(), "om-home-"))
  g.__omTestHome = home
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
    OPENCODE_MEMORY_DATA_DIR: join(home, "memory-data"),
  }
  for (const [k, v] of Object.entries(env)) {
    mkdirSync(v, { recursive: true })
    process.env[k] = v
  }
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {}
  })
}

export const testHome = g.__omTestHome
