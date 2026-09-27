import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { existsSync, readFileSync, statSync } from "node:fs"
import { timingSafeEqual } from "node:crypto"
import { homedir } from "node:os"
import { basename, extname, join, normalize, relative, resolve, sep } from "node:path"
import {
  API_VERSION,
  CONFIG_META,
  TOKEN_HEADER,
  TOKEN_META,
  getSession,
  mergeConfig,
  MIN_TIMER_MS,
  redact,
  saveConfigPatch,
  sanitizeConfigPatch,
  stripSensitiveConfigPatch,
  type AccessContext,
  type MemoryConfig,
  type MemoryEngine,
  type ScopeKind,
  type ServedConfig,
} from "@opencode-memory/core"

export const VERSION = "0.1.0"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
}

export type HttpLog = (level: "debug" | "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void

export type MemoryHttp = {
  server: Server
  port: number
  token: string
  serving: boolean
  close: () => Promise<void>
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function ownOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase().split(",")[0]!.trim()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`
}

export function originAllowed(origin: string | undefined, port: number, allowed: string[]): boolean {
  if (!origin) return true
  if (ownOrigins(port).includes(origin)) return true
  return allowed.includes(origin)
}

export function isPageNavigation(method: string, path: string, mode: string): boolean {
  if (method !== "GET") return false
  if (mode !== "navigate") return false
  return path === "/embed" || path === "/app" || path.startsWith("/app/")
}

export function tokenEqual(got: string, expected: string): boolean {
  const a = Buffer.from(got)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    const dummy = Buffer.alloc(b.length)
    try {
      timingSafeEqual(dummy, b)
    } catch {}
    return false
  }
  return timingSafeEqual(a, b)
}

function maskHeaders(h?: Record<string, string>): Record<string, string> | undefined {
  if (!h) return h
  return Object.fromEntries(Object.keys(h).map((k) => [k, "***"]))
}

export function maskConfig(cfg: MemoryConfig): MemoryConfig {
  const clone = structuredClone(cfg)
  clone.embeddings = { ...clone.embeddings, headers: maskHeaders(clone.embeddings.headers) }
  if (clone.runner.direct) {
    clone.runner = { ...clone.runner, direct: { ...clone.runner.direct, headers: maskHeaders(clone.runner.direct.headers) } }
  }
  if (clone.reflectorRunner?.direct) {
    clone.reflectorRunner = {
      ...clone.reflectorRunner,
      direct: { ...clone.reflectorRunner.direct, headers: maskHeaders(clone.reflectorRunner.direct.headers) },
    }
  }
  return clone
}

function csp(allowed: string[]): string {
  const ancestors = ["'self'", ...allowed].join(" ")
  return [
    `default-src 'self'`,
    `img-src 'self' data: blob:`,
    `style-src 'self' 'unsafe-inline'`,
    `script-src 'self'`,
    `frame-ancestors ${ancestors}`,
  ].join("; ")
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-length": Buffer.byteLength(body), ...headers })
  res.end(body)
}

function json(res: ServerResponse, status: number, payload: unknown, extra: Record<string, string> = {}) {
  const body = JSON.stringify(payload)
  send(res, status, body, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", ...extra })
}

function ok(res: ServerResponse, data: unknown, status = 200) {
  json(res, status, { ok: true, data })
}

function fail(res: ServerResponse, error: string, status = 400) {
  json(res, status, { ok: false, error }, status === 401 ? { "www-authenticate": "X-OM-Token" } : {})
}

function htmlHeaders(allowed: string[]): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": csp(allowed),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  }
}

function injectIndex(html: string, token: string, served: ServedConfig): string {
  const metas = `<meta name="${TOKEN_META}" content="${esc(token)}">\n<meta name="${CONFIG_META}" content="${esc(JSON.stringify(served))}">`
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${metas}\n</head>`)
  return `<!doctype html><html><head>${metas}</head><body>${html}</body></html>`
}

function csv(v: string | null): string[] | undefined {
  if (!v?.trim()) return undefined
  return v.split(",").map((s) => s.trim()).filter(Boolean)
}

function num(v: string | null): number | undefined {
  if (v == null || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function decodePart(s: string | undefined): string | undefined {
  if (s == null) return s
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const MAX_BODY = 1_000_000
/** Past this an oversized body is no longer drained; the reply goes out and the socket closes. */
const MAX_DRAIN = 16 * MAX_BODY

/** The body text, or undefined when it exceeds MAX_BODY (the rest is drained, not buffered). */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    req.on("data", (c: Buffer | string) => {
      n += typeof c === "string" ? Buffer.byteLength(c) : c.length
      if (n > MAX_BODY) {
        chunks.length = 0
        if (n > MAX_DRAIN) resolve(undefined)
        return
      }
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    })
    req.on("end", () => resolve(n > MAX_BODY ? undefined : Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function tooLarge(res: ServerResponse) {
  json(res, 400, { ok: false, error: "payload too large" }, { connection: "close" })
}

function isJsonPost(req: IncomingMessage): boolean {
  const ct = String(req.headers["content-type"] ?? "")
  return ct.toLowerCase().startsWith("application/json")
}

function dashCtx(engine: MemoryEngine, q: URLSearchParams, body?: any): AccessContext {
  const session = String(q.get("session") ?? body?.session ?? "") || undefined
  const project = String(q.get("project") ?? body?.project ?? "") || undefined
  if (session) {
    const c = engine.contextForSession(session)
    if (c) return c
  }
  if (project) return engine.context(project, session)
  const id = engine.localProjectIds()[0] ?? engine.projects()[0]?.id ?? "unknown"
  return engine.context(id, session)
}

function directoryOf(engine: MemoryEngine, sessionId?: string, projectId?: string): string {
  if (sessionId) {
    const s = engine.sessionStatus(sessionId)
    const row = s.projectId ? engine.projectRow(s.projectId) : undefined
    if (row?.directory) return row.directory
    if (s.projectId) {
      const a = engine.adapterForProject(s.projectId)
      if (a) return a.directory
    }
  }
  if (projectId) {
    const row = engine.projectRow(projectId)
    if (row?.directory) return row.directory
    const a = engine.adapterForProject(projectId)
    if (a) return a.directory
  }
  const first = [...engine.localProjectIds()][0]
  return (first && engine.adapterForProject(first)?.directory) || ""
}

/**
 * Boundary a user forget from a session or project view admits ids through. The forget
 * itself stays global; absent (no session/project given) admits everything.
 */
function admitCtx(engine: MemoryEngine, q: URLSearchParams, body: any): AccessContext | undefined {
  const session = String(q.get("session") ?? body?.session ?? "") || undefined
  if (session) return engine.contextForSession(session) ?? undefined
  const project = String(q.get("project") ?? body?.project ?? "") || undefined
  return project ? engine.context(project) : undefined
}

export const NO_OWNER = "No OpenCode window owns this project"
/** Core's tick heartbeats every 15s and drops instance rows older than this. */
const INSTANCE_STALE_MS = 120_000

function normDir(d: string): string {
  const r = resolve(d).replace(/[\\/]+$/, "")
  return process.platform === "win32" ? r.toLowerCase() : r
}

/** Directories of OpenCode instances with a fresh heartbeat, most recent first. */
function liveInstanceDirs(engine: MemoryEngine, now = Date.now()): string[] {
  return engine.db
    .prepare("SELECT directory FROM instances WHERE heartbeat_at >= ? ORDER BY heartbeat_at DESC")
    .all<{ directory: string }>(now - INSTANCE_STALE_MS)
    .map((r) => r.directory)
}

/** Whether this process or a live instance would claim a command routed to `directory`. */
export function directoryOwned(engine: MemoryEngine, directory: string, now = Date.now()): boolean {
  if (!directory) return false
  if (engine.adapterForDirectory(directory)) return true
  const want = normDir(directory)
  return liveInstanceDirs(engine, now).some((d) => normDir(d) === want)
}

function parseStored(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

function safeAsset(root: string, rel: string): string | undefined {
  const cleaned = rel.replace(/^[/\\]+/, "")
  const full = normalize(join(root, cleaned))
  const base = normalize(root)
  const relTo = relative(base, full)
  if (!relTo || relTo.startsWith("..") || relTo.split(sep).includes("..")) return undefined
  if (!existsSync(full) || !statSync(full).isFile()) return undefined
  return full
}

function placeholderHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Memory</title></head><body><p>Memory dashboard is not built yet.</p></body></html>`
}

function done(res: ServerResponse, changed: boolean, error = "not found", status = 404) {
  if (!changed) return fail(res, error, status)
  ok(res, { done: true })
}

/** Status for an engine `{ ok: false, error }` result. */
export function engineFailStatus(error: string): number {
  if (/not found|no recorded source|not readable|cannot read/i.test(error)) return 404
  if (/forgotten|could not supersede|pending review/i.test(error)) return 409
  return 400
}

/** Status for a failed remember/supersede: core's `WriteFailure.status`, else guessed from the message. */
export function writeFailStatus(r: { error: string; status?: number }): number {
  return typeof r.status === "number" && MEMORY_ERROR_STATUS.has(r.status) ? r.status : engineFailStatus(r.error)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

const CONFIG_ENUMS: Record<string, readonly string[]> = {
  "runner.kind": ["opencode-session", "direct"],
  "reflectorRunner.kind": ["opencode-session", "direct"],
  "embeddings.provider": ["none", "openai-compatible"],
}
const OPTIONAL_TOP_LEVEL = new Set(["reflectorRunner"])
const TIMER_KEYS = new Set(["runner.timeoutMs", "reflectorRunner.timeoutMs", "observe.leaseMs"])

/** Drop top-level keys the config does not have (e.g. a stray `confirm`). */
export function knownConfigKeys(current: MemoryConfig, patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([k]) => k in current || OPTIONAL_TOP_LEVEL.has(k)))
}

/** Shape-check an untrusted patch against the live config so a bad value can't be persisted and break startup. */
export function checkConfigPatch(current: unknown, patch: unknown, path = ""): string | undefined {
  if (!isObj(patch)) return `${path || "patch"} must be an object`
  for (const [k, v] of Object.entries(patch)) {
    const at = path ? `${path}.${k}` : k
    const cur = isObj(current) ? current[k] : undefined
    const choices = CONFIG_ENUMS[at]
    if (choices) {
      if (typeof v !== "string" || !choices.includes(v)) return `${at} must be one of ${choices.join(", ")}`
      continue
    }
    if (v === null || v === undefined) return `${at} must not be empty`
    if (typeof v === "number" && (!Number.isFinite(v) || v < 0)) return `${at} must be a non-negative number`
    if (TIMER_KEYS.has(at) && typeof v === "number" && v < MIN_TIMER_MS) return `${at} must be at least ${MIN_TIMER_MS} ms`
    if (cur === undefined || cur === null) {
      if (isObj(v)) {
        const err = checkConfigPatch(undefined, v, at)
        if (err) return err
      }
      continue
    }
    if (isObj(cur)) {
      if (!isObj(v)) return `${at} must be an object`
      const err = checkConfigPatch(cur, v, at)
      if (err) return err
      continue
    }
    if (Array.isArray(cur)) {
      if (!Array.isArray(v)) return `${at} must be a list`
      continue
    }
    if (typeof v !== typeof cur) return `${at} must be a ${typeof cur}`
  }
  return undefined
}

function reviewItemsFor(engine: MemoryEngine, state: string, session: string | null) {
  if (!session) return engine.reviewItems(state)
  const ctx = engine.contextForSession(session)
  return ctx ? engine.reviewItems(state, { ctx }) : []
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    engine: MemoryEngine
    token: string
    dashboardDir: string
    port: number
    serving?: boolean
    log?: HttpLog
  },
): Promise<void> {
  const { engine, token, dashboardDir, port } = ctx
  const config = engine.config
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  if (!hostAllowed(host, port)) {
    fail(res, "forbidden host", 403)
    return
  }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
  const method = (req.method ?? "GET").toUpperCase()
  const path = url.pathname
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
  const site = String(req.headers["sec-fetch-site"] ?? "")
  const mode = String(req.headers["sec-fetch-mode"] ?? "")
  if (origin) {
    if (!originAllowed(origin, port, config.allowedOrigins)) {
      fail(res, "forbidden origin", 403)
      return
    }
  } else if (site === "cross-site") {
    if (!isPageNavigation(method, path, mode)) {
      fail(res, "forbidden origin", 403)
      return
    }
  }

  if (path === "/health") {
    const payload = { ok: true as const, name: "opencode-memory" as const, version: VERSION, api: API_VERSION }
    const extra: Record<string, string> = { "content-type": "application/json; charset=utf-8" }
    if (origin && originAllowed(origin, port, config.allowedOrigins)) extra["access-control-allow-origin"] = origin
    json(res, 200, payload, extra)
    return
  }

  if (method === "GET" && path === "/") {
    res.writeHead(302, { location: "/app" })
    res.end()
    return
  }

  const served: ServedConfig = { port, allowedOrigins: config.allowedOrigins, version: VERSION }
  const spa = path === "/embed" || path === "/app" || path.startsWith("/app/")
  if (method === "GET" && spa) {
    const indexPath = join(dashboardDir, "index.html")
    const raw = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : placeholderHtml()
    const body = injectIndex(raw, token, served)
    send(res, 200, body, htmlHeaders(config.allowedOrigins))
    return
  }

  if (method === "GET" && path.startsWith("/assets/")) {
    const file = safeAsset(join(dashboardDir, "assets"), path.slice("/assets/".length))
    if (!file) {
      fail(res, "not found", 404)
      return
    }
    const buf = readFileSync(file)
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": buf.length,
      "x-content-type-options": "nosniff",
    })
    res.end(buf)
    return
  }

  if (!path.startsWith("/api/")) {
    fail(res, "not found", 404)
    return
  }

  if (method === "OPTIONS") {
    json(res, 403, { ok: false, error: "cors not allowed" })
    return
  }

  const got = String(req.headers[TOKEN_HEADER] ?? "")
  if (!tokenEqual(got, token)) {
    fail(res, "unauthorized", 401)
    return
  }

  if (method === "POST" && !isJsonPost(req)) {
    fail(res, "content-type must be application/json", 400)
    return
  }

  let body: any = {}
  if (method === "POST") {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return tooLarge(res)
    let raw: string | undefined
    try {
      raw = await readBody(req)
    } catch {
      fail(res, "invalid body", 400)
      return
    }
    if (raw === undefined) return tooLarge(res)
    try {
      body = raw.trim() ? JSON.parse(raw) : {}
    } catch {
      fail(res, "invalid json", 400)
      return
    }
    if (!isObj(body)) {
      fail(res, "body must be a JSON object", 400)
      return
    }
  }

  const parts = path.split("/").filter(Boolean).map((p) => decodePart(p)!)
  const q = url.searchParams

  try {
    await routeApi(engine, method, parts, q, body, res, ctx.serving === true)
  } catch (e) {
    const known = knownError(e)
    if (known) {
      fail(res, known.message, known.status)
      return
    }
    ctx.log?.("error", `api error on ${method} ${path}: ${e instanceof Error ? e.stack || e.message : String(e)}`)
    fail(res, "internal error", 500)
  }
}

const MEMORY_ERROR_STATUS = new Set([400, 403, 404, 409])

const ABS_PATH = /(^|[\s"'(`])((?:[A-Za-z]:|~)?[\\/](?:[^\s"'()`\\/]+[\\/])+[^\s"'()`\\/]*)/g

/** Replace absolute paths (and the home directory) in a user-facing message with their last segment. */
export function scrubPaths(message: string): string {
  const home = homedir()
  const text = home && home.length > 1 ? message.split(home).join("~") : message
  return text.replace(ABS_PATH, (_all, pre: string, path: string) => `${pre}${path.split(/[\\/]+/).filter(Boolean).pop() ?? ""}`)
}

/** Restore refusals thrown as plain errors by core builds that predate MemoryError for them. */
const RESTORE_REFUSALS: [RegExp, number][] = [
  [/^refusing to restore\b/i, 409],
  [/^(backup file is missing or empty|not an opencode-memory backup|backup schema \S+ is not supported)/i, 400],
]

/** Core `MemoryError` (matched by name so older/newer core builds both work) and a few known engine throws. */
export function knownError(e: unknown): { status: number; message: string } | undefined {
  if (!(e instanceof Error)) return undefined
  const status = (e as { status?: unknown }).status
  if (e.name === "MemoryError" && typeof status === "number" && MEMORY_ERROR_STATUS.has(status)) {
    return { status, message: scrubPaths(e.message) || "request failed" }
  }
  if (/unknown backup/i.test(e.message)) return { status: 400, message: "unknown backup" }
  if (/forgotten earlier/i.test(e.message)) return { status: 409, message: "this content was forgotten earlier and will not be stored again" }
  const refusal = RESTORE_REFUSALS.find(([re]) => re.test(e.message))
  if (refusal) return { status: refusal[1], message: scrubPaths(e.message) }
  return undefined
}

async function routeApi(
  engine: MemoryEngine,
  method: string,
  parts: string[],
  q: URLSearchParams,
  body: any,
  res: ServerResponse,
  serving: boolean,
) {
  const config = engine.config
  const [, a, b, c] = parts
  const needConfirm = () => {
    if (body?.confirm !== true) {
      fail(res, "destructive action requires confirm: true", 400)
      return false
    }
    return true
  }

  if (method === "GET" && a === "status") {
    const session = q.get("session")
    ok(res, { global: engine.globalStatus(), session: session ? engine.sessionStatus(session) : undefined, servesDashboard: serving })
    return
  }
  if (method === "GET" && a === "projects") {
    ok(res, engine.projects())
    return
  }
  if (method === "GET" && a === "workspaces") {
    ok(res, engine.workspaces())
    return
  }
  if (method === "GET" && a === "sessions") {
    ok(res, engine.sessions({ projectId: q.get("project") ?? undefined, limit: num(q.get("limit")) }))
    return
  }
  if (method === "GET" && a === "observations" && b && !c) {
    const row = engine.observation(b)
    if (!row) return fail(res, "not found", 404)
    ok(res, row)
    return
  }
  if (method === "GET" && a === "observations") {
    ok(
      res,
      engine.listAll({
        sessionId: q.get("session") ?? undefined,
        projectId: q.get("project") ?? undefined,
        workspace: q.get("workspace") ?? undefined,
        scopeKind: q.get("scope") as ScopeKind | undefined,
        kinds: csv(q.get("kinds")),
        evidence: csv(q.get("evidence")),
        statuses: csv(q.get("statuses")),
        query: q.get("q") ?? undefined,
        before: num(q.get("before")),
        limit: num(q.get("limit")),
      }),
    )
    return
  }
  if (method === "GET" && a === "search") {
    const ctx = dashCtx(engine, q)
    ok(
      res,
      engine.search(ctx, q.get("q") ?? "", {
        kinds: csv(q.get("kinds")),
        scopes: csv(q.get("scopes")) as ScopeKind[] | undefined,
        includeHistory: q.get("history") === "1",
        limit: num(q.get("limit")),
      }),
    )
    return
  }
  if (method === "GET" && a === "recall") {
    const ctx = dashCtx(engine, q)
    const r = engine.recallSource(ctx, {
      observationId: q.get("observation") ?? undefined,
      sessionId: q.get("session") ?? undefined,
      fromSeq: num(q.get("from")),
      toSeq: num(q.get("to")),
      context: num(q.get("context")),
    })
    if (!r.ok) return fail(res, r.error, 404)
    ok(res, r)
    return
  }
  if (method === "GET" && a === "timeline") {
    const session = q.get("session")
    if (!session) return fail(res, "session required")
    ok(res, engine.timeline(session))
    return
  }
  if (method === "GET" && a === "context") {
    const session = q.get("session")
    if (!session) return fail(res, "session required")
    ok(res, { latest: engine.latestSnapshot(session), snapshots: engine.snapshots(session) })
    return
  }
  if (method === "GET" && a === "review") {
    ok(res, reviewItemsFor(engine, q.get("state") ?? "open", q.get("session")))
    return
  }
  if (method === "POST" && a === "review" && b) {
    const decision = body.decision
    if (decision !== "approve" && decision !== "reject") return fail(res, "decision must be approve or reject", 400)
    const item = engine.db.prepare("SELECT state FROM review_items WHERE id = ?").get<{ state: string }>(b)
    if (!item) return fail(res, "not found", 404)
    if (item.state !== "open") return fail(res, "already resolved", 409)
    const edit = typeof body.content === "string" && body.content.trim() ? { content: body.content } : undefined
    return done(res, !!engine.resolveReview(b, decision, edit), "review item could not be resolved", 409)
  }
  if (method === "POST" && a === "observations" && b && c) {
    const row = engine.db.prepare("SELECT status FROM observations WHERE id = ?").get<{ status: string }>(b)
    if (c === "pin") {
      if (typeof body.pinned !== "boolean") return fail(res, "pinned must be a boolean")
      if (!row) return fail(res, "not found", 404)
      return done(res, engine.pin(b, body.pinned))
    }
    if (c === "edit") {
      const content = typeof body.content === "string" ? body.content.trim() : ""
      if (!content) return fail(res, "content required")
      if (!row) return fail(res, "not found", 404)
      if (row.status === "forgotten") return fail(res, "observation was forgotten", 409)
      return done(res, engine.edit(b, content), "observation could not be edited", 409)
    }
    if (c === "supersede") {
      const content = typeof body.content === "string" ? body.content.trim() : ""
      if (!content) return fail(res, "content required")
      const ctx = dashCtx(engine, q, body)
      const r = engine.supersede(ctx, b, content, String(body.reason ?? "dashboard"), "user")
      if (!r.ok) return fail(res, r.error, writeFailStatus(r))
      const next = engine.db.prepare("SELECT status, scope_kind FROM observations WHERE id = ?").get<{ status: string; scope_kind: string }>(r.id)
      ok(res, { id: r.id, status: next?.status ?? "active", scope: next?.scope_kind ?? null })
      return
    }
  }
  if (method === "POST" && a === "remember") {
    const content = typeof body.content === "string" ? body.content : ""
    if (!content.trim()) return fail(res, "content required")
    if (body.payload !== undefined && body.payload !== null && !isObj(body.payload)) return fail(res, "payload must be an object")
    const ctx = dashCtx(engine, q, body)
    const r = engine.remember(ctx, {
      content,
      kind: typeof body.kind === "string" ? body.kind : undefined,
      scope: typeof body.scope === "string" ? (body.scope as ScopeKind) : undefined,
      actor: "user",
      sessionId: typeof body.session === "string" ? body.session : ctx.sessionId,
      ...(isObj(body.payload) ? { payload: body.payload } : {}),
    })
    if (!r.ok) return fail(res, r.error, writeFailStatus(r))
    ok(res, { id: r.id, status: r.status, scope: r.scope })
    return
  }
  if (method === "POST" && a === "forget" && b === "candidates") {
    ok(res, engine.forgetCandidates(String(body.text ?? ""), admitCtx(engine, q, body)))
    return
  }
  if (method === "POST" && a === "forget" && b === "session") {
    if (!needConfirm()) return
    const session = typeof body.session === "string" ? body.session : ""
    if (!session) return fail(res, "session required")
    if (!getSession(engine.db, session)) return fail(res, "not found", 404)
    const already = engine.sessionForgotten(session)
    const r = await engine.forgetSession(session, "user")
    if (already && !r.observationIds.length && !r.partsPurged && !r.snapshotsPurged) return fail(res, "session was already forgotten; nothing left to forget", 404)
    ok(res, { ...r, skipped: r.skipped ?? [] })
    return
  }
  if (method === "POST" && a === "forget") {
    if (!needConfirm()) return
    const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === "string" && x.trim()) : []
    if (!ids.length) return fail(res, "ids required")
    const purge = body.purgeSources ?? "none"
    if (purge !== "none" && purge !== "sources") return fail(res, "purgeSources must be sources or none")
    const ctx = admitCtx(engine, q, body)
    const r = await engine.forget(ids, {
      actor: "user",
      reason: String(body.reason ?? "dashboard"),
      purgeSources: purge,
      scope: "global",
      ...(ctx ? { ctx } : {}),
    })
    if (!r.observationIds.length) return fail(res, r.skipped?.length ? "not found in this session's scope" : "not found", 404)
    ok(res, { ...r, skipped: r.skipped ?? [] })
    return
  }
  if (method === "POST" && a === "flush") {
    const session = typeof body.session === "string" ? body.session : ""
    if (!session) return fail(res, "session required")
    if (!getSession(engine.db, session)) return fail(res, "not found", 404)
    const dir = directoryOf(engine, session)
    if (!directoryOwned(engine, dir)) return fail(res, NO_OWNER, 409)
    ok(res, await engine.routeCommand(dir, "flush", { sessionId: session }))
    return
  }
  if (method === "POST" && a === "reflect") {
    const scopeKey = typeof body.scopeKey === "string" ? body.scopeKey : ""
    if (!scopeKey) return fail(res, "scopeKey required")
    const projectId = scopeKey.startsWith("project:") ? scopeKey.slice("project:".length) : undefined
    let dir = directoryOf(engine, undefined, projectId)
    if (!projectId && !directoryOwned(engine, dir)) dir = liveInstanceDirs(engine)[0] ?? ""
    if (!directoryOwned(engine, dir)) return fail(res, NO_OWNER, 409)
    ok(res, await engine.routeCommand(dir, "reflect", { scopeKey }))
    return
  }
  if (method === "POST" && a === "pause") {
    if (typeof body.paused !== "boolean") return fail(res, "paused must be a boolean")
    if (body.untilMs !== undefined && (typeof body.untilMs !== "number" || !Number.isFinite(body.untilMs))) return fail(res, "untilMs must be a number")
    engine.setPaused(body.paused, body.untilMs)
    ok(res, { done: true })
    return
  }
  if (method === "POST" && a === "sessions" && b && c === "flags") {
    const flags = (["excluded", "paused"] as const).filter((f) => body[f] !== undefined)
    if (!flags.length) return fail(res, "paused or excluded required")
    const bad = flags.find((f) => typeof body[f] !== "boolean")
    if (bad) return fail(res, `${bad} must be a boolean`)
    if (!engine.sessionStatus(b).known) return fail(res, "not found", 404)
    // excluded first: un-excluding a forgotten session throws 409 before anything changed.
    for (const f of flags) engine.setSessionFlag(b, f, body[f])
    ok(res, { done: true })
    return
  }
  if (method === "POST" && a === "chunks" && b === "retry-quarantined") {
    ok(res, { n: engine.retryQuarantined(typeof body.session === "string" && body.session ? body.session : undefined) })
    return
  }
  if (method === "POST" && a === "chunks" && b && c === "retry") {
    const chunk = engine.db.prepare("SELECT state FROM chunks WHERE id = ?").get<{ state: string }>(b)
    if (!chunk) return fail(res, "not found", 404)
    return done(res, engine.retryChunk(b), `chunk is ${chunk.state}, not retryable`, 409)
  }
  if (method === "GET" && a === "operations") {
    ok(res, engine.operations(num(q.get("limit")) ?? 50))
    return
  }
  if (method === "GET" && a === "jobs") {
    ok(res, engine.jobs())
    return
  }
  if (method === "GET" && a === "commands" && b) {
    const id = Number(b)
    if (!Number.isFinite(id)) return fail(res, "not found", 404)
    const row = engine.commandStatus(id)
    if (!row) return fail(res, "not found", 404)
    ok(res, { ...row, result: parseStored(row.result) })
    return
  }
  if (method === "GET" && a === "topics" && b) {
    const t = engine.topic(b)
    if (!t) return fail(res, "not found", 404)
    ok(res, t)
    return
  }
  if (method === "GET" && a === "topics") {
    const scope = csv(q.get("scope"))
    ok(res, engine.topics(scope))
    return
  }
  if (method === "POST" && a === "topics" && b && c === "approve") {
    return done(res, engine.approveTopic(b))
  }
  if (method === "POST" && a === "topics" && b && c === "rollback") {
    const generation = body.generation
    if (typeof generation !== "number" || !Number.isInteger(generation)) return fail(res, "generation must be an integer")
    if (!engine.topic(b)) return fail(res, "not found", 404)
    return done(res, engine.rollbackTopic(b, generation), "generation not found", 404)
  }
  if (method === "GET" && a === "learning") {
    ok(res, engine.learning(q.get("workspace") ?? "personal-knowledge"))
    return
  }
  if (method === "GET" && a === "research") {
    ok(res, engine.research(q.get("workspace") ?? "personal-knowledge"))
    return
  }
  if (method === "GET" && a === "artifacts" && b) {
    const row = engine.artifactContent(b)
    if (!row) return fail(res, "not found", 404)
    ok(res, row)
    return
  }
  if (method === "GET" && a === "artifacts") {
    ok(res, engine.artifacts({ workspace: q.get("workspace") ?? undefined, projectId: q.get("project") ?? undefined }))
    return
  }
  if (method === "GET" && a === "backups") {
    ok(res, engine.backups())
    return
  }
  if (method === "POST" && a === "backups" && b === "restore") {
    if (!needConfirm()) return
    const file = String(body.file ?? "")
    const known = engine.backups().some((x: { file: string }) => x.file === file)
    if (!known) return fail(res, "unknown backup", 400)
    ok(res, engine.restore(file))
    return
  }
  if (method === "POST" && a === "backups" && !b) {
    ok(res, { file: basename(engine.backupNow()) })
    return
  }
  if (method === "GET" && a === "export") {
    ok(res, engine.exportJson(q.get("workspace") ?? undefined))
    return
  }
  if (method === "GET" && a === "config") {
    ok(res, maskConfig(config))
    return
  }
  if (method === "POST" && a === "config") {
    if (!isObj(body?.patch)) return fail(res, "patch required", 400)
    const current = engine.config
    const patch = stripSensitiveConfigPatch(knownConfigKeys(current, body.patch)) as Record<string, unknown>
    const invalid = checkConfigPatch(current, patch)
    if (invalid) return fail(res, invalid, 400)
    const next = sanitizeConfigPatch(current, mergeConfig(current, patch))
    saveConfigPatch(patch)
    engine.updateConfig(next)
    ok(res, maskConfig(engine.config))
    return
  }
  if (method === "POST" && a === "redact-test") {
    ok(res, redact(String(body.text ?? "")))
    return
  }

  fail(res, "not found", 404)
}

function probeHealth(port: number): Promise<{ ours: boolean; name?: string }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: "/health", method: "GET", timeout: 1500 },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString("utf8"))
            resolve({ ours: j?.name === "opencode-memory", name: j?.name })
          } catch {
            resolve({ ours: false })
          }
        })
      },
    )
    req.on("error", () => resolve({ ours: false }))
    req.on("timeout", () => {
      req.destroy()
      resolve({ ours: false })
    })
    req.end()
  })
}

export function listenMemoryHttp(
  engine: MemoryEngine,
  opts: { token: string; dashboardDir: string; log: HttpLog; retryMs?: number },
): Promise<MemoryHttp> {
  const port = engine.config.port
  const handle: MemoryHttp = {
    server: undefined as unknown as Server,
    port,
    token: opts.token,
    serving: false,
    close: async () => {},
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      engine,
      token: opts.token,
      dashboardDir: opts.dashboardDir,
      port,
      serving: handle.serving,
      log: opts.log,
    }).catch((e) => {
      opts.log("error", `http handler crashed: ${String(e)}`)
      if (!res.headersSent) fail(res, "internal error", 500)
    })
  })
  handle.server = server
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (handle.serving) opts.log("error", `memory http error: ${e.message}`)
  })
  let retryTimer: ReturnType<typeof setInterval> | undefined
  let closed = false

  const close = () =>
    new Promise<void>((r) => {
      closed = true
      if (retryTimer) {
        clearInterval(retryTimer)
        retryTimer = undefined
      }
      try {
        server.closeAllConnections?.()
      } catch {}
      server.close(() => r())
    })
  handle.close = close

  const tryListen = () =>
    new Promise<boolean>((resolve) => {
      if (closed || handle.serving) {
        resolve(handle.serving)
        return
      }
      // A failed listen() leaves its callback registered, so use explicit listeners and detach both.
      const onError = (e: NodeJS.ErrnoException) => {
        server.off("listening", onListening)
        if (e.code !== "EADDRINUSE") opts.log("error", `memory http failed: ${e.message}`)
        resolve(false)
      }
      const onListening = () => {
        server.off("error", onError)
        server.unref()
        if (closed) {
          server.close()
          resolve(false)
          return
        }
        handle.serving = true
        opts.log("info", `memory dashboard http://127.0.0.1:${port}/app`)
        resolve(true)
      }
      server.once("error", onError)
      server.once("listening", onListening)
      try {
        server.listen(port, "127.0.0.1")
      } catch (e) {
        server.off("error", onError)
        server.off("listening", onListening)
        opts.log("error", `memory http failed: ${String(e)}`)
        resolve(false)
      }
    })

  return (async () => {
    const bound = await tryListen()
    if (!bound) {
      const health = await probeHealth(port).catch(() => ({ ours: false as const }))
      if (health.ours) {
        opts.log("info", `memory dashboard already bound on 127.0.0.1:${port}; sharing the database`)
      } else {
        opts.log("warn", `127.0.0.1:${port} is in use by another process (not opencode-memory); will retry`)
      }
      retryTimer = setInterval(() => {
        void tryListen()
          .then((ok) => {
            if (ok && retryTimer) {
              clearInterval(retryTimer)
              retryTimer = undefined
            }
          })
          .catch(() => {})
      }, opts.retryMs ?? 30_000)
      retryTimer.unref?.()
    }
    return handle
  })()
}
