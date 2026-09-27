import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, "..", "dist", "index.js")
const failures = []

function assert(cond, msg) {
  if (!cond) failures.push(msg)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address()
      const port = addr && typeof addr === "object" ? addr.port : 0
      s.close((err) => (err ? reject(err) : resolve(port)))
    })
    s.on("error", reject)
  })
}

function raw(opts) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port: opts.port, path: opts.path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        )
      },
    )
    req.on("error", reject)
    req.end()
  })
}

const userText = "I prefer dark mode when writing TypeScript in this project."
const sessionID = "ses_smoke"
const canned = [
  {
    info: { id: "msg_user", sessionID, role: "user", time: { created: Date.now() } },
    parts: [{ id: "pt_u", type: "text", text: userText }],
  },
  {
    info: {
      id: "msg_asst",
      sessionID,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() + 1 },
      mode: "build",
      modelID: "fake",
      providerID: "fake",
      cost: 0,
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "pt_a", type: "text", text: "Noted. I will use a dark theme." }],
  },
]

const fakeOutput = {
  observations: [
    {
      kind: "fact",
      content: "The user prefers dark mode when writing TypeScript",
      confidence: 0.9,
      evidenceType: "explicit",
      priority: "medium",
      sources: { start: "m1", end: "m1" },
      quote: "I prefer dark mode",
      scopeHint: "session",
    },
  ],
  currentTask: "configuring the editor",
  suggestedNext: "apply the dark theme",
}

const client = {
  session: {
    create: async () => ({ data: { id: "ses_child" } }),
    prompt: async () => ({ data: { info: { structured: fakeOutput } } }),
    abort: async () => ({ data: true }),
    delete: async () => ({ data: true }),
    messages: async () => ({ data: canned }),
    get: async ({ path }) => ({ data: { id: path.id, title: "Smoke", time: { created: 1, updated: 1 } } }),
    list: async () => ({ data: [] }),
  },
  app: { log: async () => ({ data: true }) },
}

const dir = mkdtempSync(join(tmpdir(), "om-smoke-"))
let hooks

// Never read the developer's real ~/.config/opencode-memory or OpenCode config.
const home = join(dir, "home")
for (const [k, v] of Object.entries({
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
  OPENCODE_MEMORY_DATA_DIR: join(home, "memory-data"),
})) {
  mkdirSync(v, { recursive: true })
  process.env[k] = v
}

try {
  const port = await freePort()
  const mod = await import(pathToFileURL(dist).href)
  const plugin = mod.default
  assert(plugin?.id === "opencode-memory", `plugin id is ${plugin?.id}`)
  assert(typeof plugin.server === "function", "plugin.server missing")

  const input = {
    client,
    project: { id: "proj_smoke", worktree: dir, time: { created: Date.now() } },
    directory: dir,
    worktree: dir,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: undefined,
  }

  hooks = await plugin.server(input, { dataDir: dir, port, runner: "fake", fakeOutputs: [fakeOutput] })

  const cfg = { agent: {} }
  await hooks.config(cfg)
  assert(cfg.agent["om-observer"]?.hidden === true, "om-observer not registered")
  assert(cfg.agent["om-reflector"]?.mode === "subagent", "om-reflector not registered")

  await hooks.event({
    event: { type: "session.created", properties: { info: { id: sessionID, title: "Smoke", time: { created: 1, updated: 1 } } } },
  })
  await hooks["chat.message"](
    { sessionID },
    { message: { id: "msg_user", sessionID, role: "user" }, parts: canned[0].parts },
  )
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID } },
  })

  const ctx = {
    sessionID,
    messageID: "msg_tool",
    agent: "build",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
  const flushed = await hooks.tool.memory_flush.execute({}, ctx)
  assert(String(flushed).toLowerCase().includes("flush"), `flush output: ${flushed}`)

  const status = await hooks.tool.memory_status.execute({}, ctx)
  assert(typeof status === "string" && status.length > 0, "memory_status returned no text")
  assert(/observation/i.test(status), `memory_status missing observations: ${status}`)

  const sys = { system: ["You are a helpful coding assistant working in a git repository."] }
  await hooks["experimental.chat.system.transform"]({ sessionID, model: {} }, sys)
  assert(
    sys.system.some((s) => typeof s === "string" && s.includes("<opencode-memory")),
    `system.transform did not inject a memory block: ${JSON.stringify(sys.system)}`,
  )

  const token = readFileSync(join(dir, "token"), "utf8").trim()
  assert(token.length === 64, `token length ${token.length}`)

  const health = await raw({ port, path: "/health", headers: { host: `127.0.0.1:${port}` } })
  assert(health.status === 200, `/health status ${health.status}`)
  const healthJson = JSON.parse(health.body)
  assert(healthJson.ok === true && healthJson.name === "opencode-memory", `/health body ${health.body}`)

  const noTok = await raw({ port, path: "/api/status", headers: { host: `127.0.0.1:${port}` } })
  assert(noTok.status === 401, `/api/status without token -> ${noTok.status}`)

  const badHost = await raw({
    port,
    path: "/api/status",
    headers: { host: "evil.example", "x-om-token": token },
  })
  assert(badHost.status === 403, `/api/status bad host -> ${badHost.status}`)

  const ok = await raw({
    port,
    path: "/api/status",
    headers: { host: `127.0.0.1:${port}`, "x-om-token": token },
  })
  assert(ok.status === 200, `/api/status with token -> ${ok.status} ${ok.body}`)
  const data = JSON.parse(ok.body)
  assert(data.ok === true, "status not ok")
  assert(data.data.global.driver === "node", `expected node sqlite driver, got ${data.data.global.driver}`)
  assert(data.data.global.fts5 === true, `expected FTS5, got ${data.data.global.fts5}`)

  const embed = await raw({
    port,
    path: "/embed",
    headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
  })
  assert(embed.status === 200, `cross-site /embed navigation -> ${embed.status}`)
  const crossApi = await raw({
    port,
    path: "/api/status",
    headers: { host: `127.0.0.1:${port}`, "x-om-token": token, "sec-fetch-site": "cross-site" },
  })
  assert(crossApi.status === 403, `cross-site /api/status -> ${crossApi.status}`)
} catch (e) {
  failures.push(e instanceof Error ? e.stack || e.message : String(e))
} finally {
  try {
    await hooks?.dispose?.()
  } catch {}
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {}
}

if (failures.length) {
  console.error("node-smoke failed:")
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log("node-smoke ok")

// Unref'd, so it only fires if a leaked handle keeps the loop alive after dispose.
setTimeout(() => {
  console.error("node-smoke: process still alive 8s after dispose:", process.getActiveResourcesInfo().join(", "))
  process.exit(1)
}, 8000).unref()
