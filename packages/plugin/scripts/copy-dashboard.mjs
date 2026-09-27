import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, "..", "..", "dashboard", "dist")
const dest = join(here, "..", "dist", "dashboard")
const required = process.argv.includes("--require")

if (!existsSync(join(src, "index.html"))) {
  console.warn(
    "opencode-memory: packages/dashboard/dist is missing (no index.html). Dashboard assets were NOT copied. Build the dashboard first: bun run --cwd packages/dashboard build",
  )
  process.exit(required ? 1 : 0)
}

mkdirSync(dirname(dest), { recursive: true })
rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true })
console.log(`copied dashboard -> ${dest}`)
