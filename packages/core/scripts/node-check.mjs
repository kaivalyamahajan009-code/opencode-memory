// Core on the Node driver: bundle test/node-entry.ts with `bun build --target node`
// (node:sqlite and bun:sqlite left external) into a temp .mjs and run it with `node`.
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, "..", "test", "node-entry.ts")
const outDir = mkdtempSync(join(tmpdir(), "om-node-check-"))
const outFile = join(outDir, "node-entry.mjs")
const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)

let status = 1
try {
  const bun = process.env.BUN_BIN || "bun"
  const cmd = [q(bun), "build", q(entry), "--target", "node", "--format", "esm", "--outfile", q(outFile), "--external", "node:sqlite", "--external", "bun:sqlite"]
  const build = spawnSync(cmd.join(" "), { stdio: "inherit", shell: true })
  if (build.status !== 0) {
    console.error(`node-check: bun build failed (${build.error ? String(build.error) : `exit ${build.status}`})`)
  } else {
    const run = spawnSync(process.execPath, [outFile], { stdio: "inherit" })
    status = run.status ?? 1
  }
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
process.exit(status)
