import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const state = globalThis as { __omEvalHome?: string }

if (!state.__omEvalHome) {
  const home = mkdtempSync(join(tmpdir(), "om-evals-home-"))
  state.__omEvalHome = home
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
    OPENCODE_MEMORY_DATA_DIR: join(home, "memory-data"),
  }
  for (const [key, value] of Object.entries(env)) {
    mkdirSync(value, { recursive: true })
    process.env[key] = value
  }
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {}
  })
}

export const evalHome = state.__omEvalHome
