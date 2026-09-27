#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const jsonc = loadJsonc()

const uninstall = process.argv.includes("--uninstall")
const pluginFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "plugin", "dist", "index.js")
const spec = pathToFileURL(pluginFile).href

function loadJsonc() {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    "jsonc-parser",
    join(here, "..", "packages", "plugin", "node_modules", "jsonc-parser"),
    join(here, "..", "node_modules", "jsonc-parser"),
  ]
  for (const c of candidates) {
    try {
      return require(c)
    } catch {}
  }
  throw new Error("jsonc-parser is required. Add it as a devDependency (OpenCode uses jsonc-parser 3.3.1).")
}

export function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdgBase = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdgBase, "opencode")
}

/**
 * OpenCode reads opencode.json and opencode.jsonc (merged last) from OPENCODE_CONFIG_DIR,
 * never config.json; the global config dir also reads config.json.
 */
export function configFile(dir, envDir = process.env.OPENCODE_CONFIG_DIR) {
  const fromEnv = !!envDir && resolve(envDir) === resolve(dir)
  const names = fromEnv ? ["opencode.jsonc", "opencode.json"] : ["opencode.jsonc", "opencode.json", "config.json"]
  for (const name of names) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return join(dir, fromEnv ? "opencode.jsonc" : "opencode.json")
}

function specOf(entry) {
  return Array.isArray(entry) ? entry[0] : entry
}

function parseJsonc(text) {
  const errors = []
  const value = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    const first = errors[0]
    throw new Error(`JSONC parse error at offset ${first.offset}: code ${first.error}`)
  }
  return value
}

function patch(text, path, value, isArrayInsertion = false) {
  const edits = jsonc.modify(text, path, value, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
    isArrayInsertion,
  })
  return jsonc.applyEdits(text, edits)
}

export function addPlugin(text, want) {
  const cfg = parseJsonc(text) ?? {}
  const list = Array.isArray(cfg.plugin) ? cfg.plugin : undefined
  if (list?.some((e) => specOf(e) === want)) return { text, changed: false }
  const next = list ? patch(text, ["plugin", list.length], want, true) : patch(text, ["plugin"], [want])
  const check = parseJsonc(next)
  if (!Array.isArray(check?.plugin) || !check.plugin.some((e) => specOf(e) === want)) throw new Error("could not add plugin entry")
  return { text: next, changed: true }
}

export function removePlugin(text, want) {
  const cfg = parseJsonc(text) ?? {}
  const list = Array.isArray(cfg.plugin) ? cfg.plugin : []
  const hits = list.flatMap((e, i) => (specOf(e) === want ? [i] : []))
  if (!hits.length) return { text, changed: false }
  let next = text
  for (const i of hits.reverse()) next = patch(next, ["plugin", i], undefined)
  const check = parseJsonc(next)
  if (Array.isArray(check?.plugin) && check.plugin.some((e) => specOf(e) === want)) throw new Error("could not remove plugin entry")
  return { text: next, changed: true }
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dest = `${file}.bak-${stamp}`
  copyFileSync(file, dest)
  return dest
}

export function runInstall(opts = {}) {
  const dir = opts.dir ?? configDir()
  const file = opts.file ?? configFile(dir)
  const want = opts.spec ?? spec
  const doUninstall = opts.uninstall ?? uninstall
  mkdirSync(dir, { recursive: true })

  if (!existsSync(pluginFile) && !doUninstall && !opts.quiet) {
    console.warn(`Plugin build not found at ${pluginFile}. Run: bun run --cwd packages/plugin build`)
  }

  if (!existsSync(file)) {
    if (doUninstall) return { file, changed: false, created: false, text: "" }
    const cfg = { $schema: "https://opencode.ai/config.json", plugin: [want] }
    const text = `${JSON.stringify(cfg, null, 2)}\n`
    writeFileSync(file, text)
    return { file, changed: true, created: true, text }
  }

  const raw = readFileSync(file, "utf8")
  const result = doUninstall ? removePlugin(raw, want) : addPlugin(raw, want)
  if (!result.changed) return { file, changed: false, created: false, text: raw, bak: undefined }
  const bak = backup(file)
  writeFileSync(file, result.text)
  return { file, changed: true, created: false, text: result.text, bak }
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isMain()) {
  try {
    const result = runInstall()
    if (!result.changed) {
      console.log(uninstall ? `Plugin not present in ${result.file}` : existsSync(result.file) ? `Plugin already installed in ${result.file}` : `No OpenCode config at ${result.file}; nothing to uninstall.`)
      console.log(spec)
      process.exit(0)
    }
    if (result.created) {
      console.log(`Created ${result.file}`)
      console.log(`Added plugin ${spec}`)
      process.exit(0)
    }
    console.log(`Backed up ${result.file} -> ${result.bak}`)
    console.log(uninstall ? `Removed plugin ${spec}` : `Added plugin ${spec}`)
    console.log(`Config: ${result.file}`)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
