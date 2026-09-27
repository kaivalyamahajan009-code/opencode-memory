import { testHome } from "./hermetic"
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { addPlugin, configDir, configFile, removePlugin, runInstall } from "../../../scripts/install-local.mjs"
import { rmDir, tempDir } from "./helpers"

const spec = "file:///C:/tmp/opencode-memory/packages/plugin/dist/index.js"

describe("install-local JSONC", () => {
  test("preserves comments and trailing commas when adding and removing a plugin", () => {
    const raw = `{
  // keep this comment
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "other-plugin", // trailing comment with a comma,
  ],
}
`
    const added = addPlugin(raw, spec)
    expect(added.changed).toBe(true)
    expect(added.text).toContain("// keep this comment")
    expect(added.text).toContain("other-plugin")
    expect(added.text).toContain(spec)
    const again = addPlugin(added.text, spec)
    expect(again.changed).toBe(false)
    const removed = removePlugin(added.text, spec)
    expect(removed.changed).toBe(true)
    expect(removed.text).toContain("other-plugin")
    expect(removed.text).not.toContain(spec)
    expect(removed.text).toContain("// keep this comment")
  })

  test("keeps comments inside the plugin array and removes duplicate entries", () => {
    const raw = `{
  "plugin": [
    // first
    "a",
    ["${spec}", { "x": 1 }],
    /* block */ "b",
    "${spec}",
  ],
}
`
    const removed = removePlugin(raw, spec)
    expect(removed.changed).toBe(true)
    expect(removed.text).toContain("// first")
    expect(removed.text).toContain('"b"')
    expect(removed.text).not.toContain(spec)
    const added = addPlugin(removed.text, spec)
    expect(added.text).toContain("// first")
    expect(added.text).toContain(spec)
  })

  test("rejects invalid JSONC instead of rewriting it", () => {
    expect(() => addPlugin(`{ "plugin": [ "a" `, spec)).toThrow()
  })

  test("does not match a commented-out plugin key", () => {
    const raw = `{
  // "plugin": ["should-not-match"],
  "model": "opencode/big-pickle",
}
`
    const added = addPlugin(raw, spec)
    expect(added.changed).toBe(true)
    expect(added.text).toContain(spec)
    expect(added.text).toContain("// \"plugin\"")
  })

  test("runInstall backs up, is idempotent, and --uninstall restores the entry list", () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "opencode.jsonc")
    const raw = `{\n  // mine\n  "plugin": ["x",],\n}\n`
    writeFileSync(file, raw)
    try {
      const first = runInstall({ dir, file, spec, uninstall: false, quiet: true })
      expect(first.changed).toBe(true)
      expect(first.bak && existsSync(first.bak)).toBeTruthy()
      expect(readFileSync(first.bak!, "utf8")).toBe(raw)
      expect(runInstall({ dir, file, spec, uninstall: false, quiet: true }).changed).toBe(false)
      const gone = runInstall({ dir, file, spec, uninstall: true, quiet: true })
      expect(gone.changed).toBe(true)
      const text = readFileSync(file, "utf8")
      expect(text).toContain("// mine")
      expect(text).toContain('"x"')
      expect(text).not.toContain(spec)
    } finally {
      rmDir(dir)
    }
  })

  test("with OPENCODE_CONFIG_DIR only opencode.json / opencode.jsonc there are used; opencode.jsonc is created", () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, "config.json"), `{ "plugin": [] }\n`)
      expect(configFile(dir, dir)).toBe(join(dir, "opencode.jsonc"))
      expect(configFile(dir, undefined)).toBe(join(dir, "config.json"))
      const created = runInstall({ dir, file: configFile(dir, dir), spec, uninstall: false, quiet: true })
      expect(created.created).toBe(true)
      expect(created.file).toBe(join(dir, "opencode.jsonc"))
      expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain(spec)

      writeFileSync(join(dir, "opencode.json"), `{ "plugin": [] }\n`)
      expect(configFile(dir, dir)).toBe(join(dir, "opencode.jsonc"))
      rmDir(join(dir, "opencode.jsonc"))
      expect(configFile(dir, dir)).toBe(join(dir, "opencode.json"))
    } finally {
      rmDir(dir)
    }
  })

  test("configDir follows OPENCODE_CONFIG_DIR (tests never touch the real one)", () => {
    expect(configDir()).toBe(process.env.OPENCODE_CONFIG_DIR!)
    expect(configDir().startsWith(testHome!)).toBe(true)
  })

  test("idempotent on a real temp config dir", () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "opencode.jsonc")
    writeFileSync(
      file,
      `{
  // hello
  "plugin": [],
}
`,
    )
    try {
      const first = addPlugin(readFileSync(file, "utf8"), spec)
      writeFileSync(file, first.text)
      const second = addPlugin(readFileSync(file, "utf8"), spec)
      expect(second.changed).toBe(false)
    } finally {
      rmDir(dir)
    }
  })
})
