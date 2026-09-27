import "./hermetic"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { TOKEN_HEADER, defaultConfig, MemoryEngine, MemoryError } from "@opencode-memory/core"
import {
  directoryOwned,
  engineFailStatus,
  hostAllowed,
  isPageNavigation,
  knownError,
  listenMemoryHttp,
  NO_OWNER,
  originAllowed,
  scrubPaths,
  tokenEqual,
  writeFailStatus,
} from "../src/server/http"
import { freePort, rmDir, tempDir } from "./helpers"

function raw(opts: { port: number; path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port: opts.port, path: opts.path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        )
      },
    )
    req.on("error", reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

describe("http security", () => {
  const dir = tempDir()
  let engine: MemoryEngine
  let port = 0
  const token = "t".repeat(64)
  let close: () => Promise<void> = async () => {}

  beforeAll(async () => {
    port = await freePort()
    const config = { ...defaultConfig(dir), port, allowedOrigins: ["oc://renderer"] }
    engine = await MemoryEngine.open(config)
    const http = await listenMemoryHttp(engine, { token, dashboardDir: dir, log: () => {} })
    expect(http).toBeTruthy()
    close = () => http!.close()
  })

  test("hostAllowed only loopback", () => {
    expect(hostAllowed(`127.0.0.1:${port}`, port)).toBe(true)
    expect(hostAllowed(`localhost:${port}`, port)).toBe(true)
    expect(hostAllowed(`evil.example:${port}`, port)).toBe(false)
    expect(hostAllowed(`127.0.0.1:${port}.evil.com`, port)).toBe(false)
    expect(originAllowed("oc://renderer", port, ["oc://renderer"])).toBe(true)
    expect(originAllowed("http://evil.example", port, ["oc://renderer"])).toBe(false)
  })

  test("/health is unauthenticated", async () => {
    const r = await raw({ port, path: "/health", headers: { host: `127.0.0.1:${port}` } })
    expect(r.status).toBe(200)
    const j = JSON.parse(r.body)
    expect(j.ok).toBe(true)
    expect(j.name).toBe("opencode-memory")
    expect(r.headers["access-control-allow-origin"]).toBeUndefined()
  })

  test("/health sends ACAO only for allowed origins", async () => {
    const ok = await raw({
      port,
      path: "/health",
      headers: { host: `127.0.0.1:${port}`, origin: "oc://renderer" },
    })
    expect(ok.status).toBe(200)
    expect(ok.headers["access-control-allow-origin"]).toBe("oc://renderer")
    const bad = await raw({
      port,
      path: "/health",
      headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example" },
    })
    expect(bad.status).toBe(403)
  })

  test("/api/status rejects without token", async () => {
    const r = await raw({ port, path: "/api/status", headers: { host: `127.0.0.1:${port}` } })
    expect(r.status).toBe(401)
    expect(r.headers["access-control-allow-origin"]).toBeUndefined()
  })

  test("/api/status rejects bad Host", async () => {
    const r = await raw({
      port,
      path: "/api/status",
      headers: { host: "evil.example", [TOKEN_HEADER]: token },
    })
    expect(r.status).toBe(403)
  })

  test("/api/status succeeds with token", async () => {
    const r = await raw({
      port,
      path: "/api/status",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token },
    })
    expect(r.status).toBe(200)
    const j = JSON.parse(r.body)
    expect(j.ok).toBe(true)
    expect(j.data.global.driver).toBeTruthy()
    expect(r.headers["access-control-allow-origin"]).toBeUndefined()
  })

  test("POST /api requires json and confirm", async () => {
    const noJson = await raw({
      port,
      path: "/api/forget",
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, "content-type": "text/plain" },
      body: "{}",
    })
    expect(noJson.status).toBe(400)
    const noConfirm = await raw({
      port,
      path: "/api/forget",
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, "content-type": "application/json" },
      body: JSON.stringify({ ids: ["x"] }),
    })
    expect(noConfirm.status).toBe(400)
    expect(JSON.parse(noConfirm.body).error).toContain("confirm")
  })

  test("cross-site iframe navigate to /embed is allowed", async () => {
    const r = await raw({
      port,
      path: "/embed",
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "cross-site",
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
      },
    })
    expect(r.status).toBe(200)
    expect(r.headers["referrer-policy"]).toBe("no-referrer")
    expect(r.headers["cache-control"]).toBe("no-store")
  })

  test("cross-site iframe navigate to /api is rejected", async () => {
    const r = await raw({
      port,
      path: "/api/status",
      headers: {
        host: `127.0.0.1:${port}`,
        [TOKEN_HEADER]: token,
        "sec-fetch-site": "cross-site",
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
      },
    })
    expect(r.status).toBe(403)
    expect(JSON.parse(r.body).error).toContain("origin")
  })

  test("GET /api/commands/:id unknown is 404", async () => {
    const r = await raw({
      port,
      path: "/api/commands/99999",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token },
    })
    expect(r.status).toBe(404)
  })

  test("POST pin unknown id is 404 not ok", async () => {
    const r = await raw({
      port,
      path: "/api/observations/obs_missing/pin",
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    })
    expect(r.status).toBe(404)
    expect(JSON.parse(r.body).ok).toBe(false)
  })

  test("POST review requires exact approve|reject", async () => {
    const r = await raw({
      port,
      path: "/api/review/rev_x",
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, "content-type": "application/json" },
      body: JSON.stringify({ decision: "yes" }),
    })
    expect(r.status).toBe(400)
  })

  test("POST /api/config requires patch and sanitizes live config", async () => {
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      const missing = await raw({
        port,
        path: "/api/config",
        method: "POST",
        headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, "content-type": "application/json" },
        body: JSON.stringify({ inject: { deadlineMs: 111 } }),
      })
      expect(missing.status).toBe(400)

      const portBefore = engine.config.port
      const origins = [...engine.config.allowedOrigins]
      const okPatch = await raw({
        port,
        path: "/api/config",
        method: "POST",
        headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, "content-type": "application/json" },
        body: JSON.stringify({
          patch: {
            inject: { deadlineMs: 321 },
            allowedOrigins: ["http://evil.example"],
            port: 1,
            confirm: true,
          },
        }),
      })
      expect(okPatch.status).toBe(200)
      const body = JSON.parse(okPatch.body)
      expect(body.ok).toBe(true)
      expect(body.data.inject.deadlineMs).toBe(321)
      expect(body.data.port).toBe(portBefore)
      expect(body.data.allowedOrigins).toEqual(origins)
      expect(engine.config.inject.deadlineMs).toBe(321)

      const got = await raw({
        port,
        path: "/api/config",
        headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token },
      })
      expect(JSON.parse(got.body).data.inject.deadlineMs).toBe(321)
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  })

  test("GET /api/review?session filters with canRead", async () => {
    const adapter = {
      id: "adp_http",
      directory: dir,
      project: { id: "proj_http", workspace: "personal-knowledge", domain: "general" as const, directory: dir },
      runner: { id: "fake", async run() { return { output: {}, inputTokens: 0, outputTokens: 0, cost: 0, model: "fake" } } },
      async fetchMessages() { return [] },
    }
    engine.register(adapter as any)
    engine.trackSession(adapter as any, { id: "ses_rev_a" })
    engine.trackSession(adapter as any, { id: "ses_rev_b" })
    const saved = engine.remember(engine.context("proj_http", "ses_rev_a"), {
      content: "The user has a secret medical condition called something unique",
      kind: "personal-fact",
      actor: "agent",
      sessionId: "ses_rev_a",
    })
    expect(saved.ok).toBe(true)
    const all = await raw({
      port,
      path: "/api/review?state=open",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token },
    })
    expect(all.status).toBe(200)
    const allItems = JSON.parse(all.body).data as any[]
    expect(allItems.length).toBeGreaterThan(0)
    const filtered = await raw({
      port,
      path: "/api/review?state=open&session=ses_rev_b",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token },
    })
    const filteredItems = JSON.parse(filtered.body).data as any[]
    const ids = filteredItems.map((i: any) => i.ref_id)
    if (saved.ok) expect(ids).not.toContain(saved.id)
    const own = await raw({
      port,
      path: "/api/review?state=open&session=ses_rev_a",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token },
    })
    const ownIds = JSON.parse(own.body).data.map((i: any) => i.ref_id)
    if (saved.ok) expect(ownIds).toContain(saved.id)
  })

  test("cross-site: page navigations to /app/* are allowed, subresources and /health are not", async () => {
    const base = { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" }
    const app = await raw({ port, path: "/app/topics", headers: { ...base, "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" } })
    expect(app.status).toBe(200)
    expect(String(app.headers["content-security-policy"])).toContain("frame-ancestors 'self' oc://renderer")
    const embedFetch = await raw({ port, path: "/embed", headers: { ...base, "sec-fetch-mode": "cors" } })
    expect(embedFetch.status).toBe(403)
    const asset = await raw({ port, path: "/assets/index.js", headers: { ...base, "sec-fetch-mode": "navigate" } })
    expect(asset.status).toBe(403)
    const health = await raw({ port, path: "/health", headers: { ...base, "sec-fetch-mode": "navigate" } })
    expect(health.status).toBe(403)
  })

  const api = (path: string, body?: unknown) =>
    raw({
      port,
      path,
      method: body === undefined ? "GET" : "POST",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  test("error status mapping: 404/409/400, MemoryError status, generic 500", async () => {
    const adapter = {
      id: "adp_err",
      directory: dir,
      project: { id: "proj_err", workspace: "personal-knowledge", domain: "general" as const, directory: dir },
      runner: { id: "fake", async run() { return { output: {}, inputTokens: 0, outputTokens: 0, cost: 0, model: "fake" } } },
      async fetchMessages() { return [] },
    }
    engine.register(adapter as any)
    engine.trackSession(adapter as any, { id: "ses_err" })

    expect((await api("/api/forget", { ids: ["obs_none"], confirm: true })).status).toBe(404)
    expect((await api("/api/recall?observation=obs_none&project=proj_err")).status).toBe(404)
    expect((await api("/api/backups/restore", { file: "nope.db", confirm: true })).status).toBe(400)
    expect((await api("/api/chunks/chk_none/retry", {})).status).toBe(404)
    expect((await api("/api/topics/top_none/approve", {})).status).toBe(404)

    const content = "The user keeps a unique forgettable note about blue herons"
    const saved = await api("/api/remember", { content, session: "ses_err" })
    expect(saved.status).toBe(200)
    const id = JSON.parse(saved.body).data.id as string
    const pinned = await api(`/api/observations/${encodeURIComponent(id)}/pin`, { pinned: true })
    expect(JSON.parse(pinned.body)).toEqual({ ok: true, data: { done: true } })
    const forgot = await api("/api/forget", { ids: [id], confirm: true })
    expect(forgot.status).toBe(200)
    const result = JSON.parse(forgot.body).data
    expect(result.observationIds).toContain(id)
    expect(result.skipped).toEqual([])
    expect(result.partsPurged).toBe(0)
    const again = await api("/api/remember", { content, session: "ses_err" })
    expect(again.status).toBe(409)
    expect(JSON.parse(again.body).ok).toBe(false)
    const edit = await api(`/api/observations/${id}/edit`, { content: "changed" })
    expect(edit.status).toBe(409)

    const jobs = engine.jobs
    const ops = engine.operations
    try {
      engine.jobs = () => {
        throw new Error("secret detail C:\\private\\path")
      }
      const crash = await api("/api/jobs")
      expect(crash.status).toBe(500)
      expect(JSON.parse(crash.body)).toEqual({ ok: false, error: "internal error" })
      engine.operations = () => {
        throw new MemoryError("already resolved", "conflict", 409)
      }
      const known = await api("/api/operations")
      expect(known.status).toBe(409)
      expect(JSON.parse(known.body).error).toBe("already resolved")
    } finally {
      engine.jobs = jobs
      engine.operations = ops
    }
  })

  test("GET /api/config masks header values; POST /api/backups returns a bare file name", async () => {
    const prev = engine.config
    engine.updateConfig({ ...prev, embeddings: { ...prev.embeddings, headers: { Authorization: "Bearer sk-live" } } }, { trusted: true })
    try {
      const cfg = await api("/api/config")
      expect(JSON.parse(cfg.body).data.embeddings.headers).toEqual({ Authorization: "***" })
      expect(cfg.body).not.toContain("sk-live")
    } finally {
      engine.updateConfig(prev, { trusted: true })
    }
    const made = await api("/api/backups", {})
    expect(made.status).toBe(200)
    const file = JSON.parse(made.body).data.file as string
    expect(file).toBeTruthy()
    expect(file).not.toMatch(/[\\/]/)
  })

  test("status reports whether this process serves the dashboard", async () => {
    const r = await api("/api/status")
    expect(JSON.parse(r.body).data.servesDashboard).toBe(true)
  })

  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    raw({
      port,
      path,
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, "content-type": "application/json", ...headers },
      body,
    })

  test("non-object JSON bodies are 400, not 500", async () => {
    for (const body of ["null", "[]", "[1,2]", "5", '"text"', "true"]) {
      const r = await post("/api/pause", body)
      expect({ body, status: r.status }).toEqual({ body, status: 400 })
      expect(JSON.parse(r.body)).toEqual({ ok: false, error: "body must be a JSON object" })
    }
    expect((await post("/api/pause", "{not json")).status).toBe(400)
  })

  test("oversized bodies get 400 with connection: close and a readable reply", async () => {
    const declared = await post("/api/remember", "{}", { "content-length": "2000000" })
    expect(declared.status).toBe(400)
    expect(declared.headers.connection).toBe("close")
    expect(JSON.parse(declared.body).error).toBe("payload too large")

    const streamed = await post("/api/remember", JSON.stringify({ content: "x".repeat(1_200_000) }))
    expect(streamed.status).toBe(400)
    expect(streamed.headers.connection).toBe("close")
    expect(JSON.parse(streamed.body).error).toBe("payload too large")

    const after = await api("/api/status")
    expect(after.status).toBe(200)
  })

  function project(id: string, directory: string, workspace = "personal-knowledge") {
    return {
      id: `adp_${id}`,
      directory,
      project: { id, workspace, domain: "general" as const, directory },
      runner: { id: "fake", async run() { return { output: { observations: [] }, inputTokens: 0, outputTokens: 0, cost: 0, model: "fake" } } },
      async fetchMessages() { return [] },
    }
  }

  test("session flags need a boolean field; un-excluding a forgotten session is 409 and changes nothing", async () => {
    const a = project("proj_flags", dir)
    engine.register(a as any)
    engine.trackSession(a as any, { id: "ses_flags" })
    expect((await api("/api/sessions/ses_flags/flags", {})).status).toBe(400)
    expect((await api("/api/sessions/ses_flags/flags", { paused: "yes" })).status).toBe(400)
    expect((await api("/api/sessions/ses_none/flags", { paused: true })).status).toBe(404)
    expect((await api("/api/sessions/ses_flags/flags", { paused: true })).status).toBe(200)
    expect(engine.sessionStatus("ses_flags").paused).toBe(true)
    expect((await api("/api/sessions/ses_flags/flags", { paused: false })).status).toBe(200)

    expect((await api("/api/forget/session", { session: "ses_flags", confirm: true })).status).toBe(200)
    const unexclude = await api("/api/sessions/ses_flags/flags", { excluded: false, paused: true })
    expect(unexclude.status).toBe(409)
    expect(JSON.parse(unexclude.body).error).toContain("forgotten")
    expect(engine.sessionStatus("ses_flags").paused).toBe(false)
  })

  test("forget/session is 404 once there is nothing left to forget", async () => {
    const a = project("proj_fs", dir)
    engine.register(a as any)
    engine.trackSession(a as any, { id: "ses_fs" })
    const saved = engine.remember(engine.context("proj_fs", "ses_fs"), { content: "The user tracks a unique heron sighting log", actor: "user", sessionId: "ses_fs" })
    expect(saved.ok).toBe(true)
    const first = await api("/api/forget/session", { session: "ses_fs", confirm: true })
    expect(first.status).toBe(200)
    const data = JSON.parse(first.body).data
    if (saved.ok) expect(data.observationIds).toContain(saved.id)
    expect(data.skipped).toEqual([])
    const again = await api("/api/forget/session", { session: "ses_fs", confirm: true })
    expect(again.status).toBe(404)
    expect((await api("/api/forget/session", { session: "ses_missing", confirm: true })).status).toBe(404)
  })

  test("user forget from a session view is global: the session only admits ids", async () => {
    const dirA = tempDir()
    const dirB = tempDir()
    try {
      const a = project("proj_ga", dirA, "ws-a")
      const b = project("proj_gb", dirB, "ws-b")
      engine.register(a as any)
      engine.register(b as any)
      engine.trackSession(a as any, { id: "ses_ga" })
      engine.trackSession(b as any, { id: "ses_gb" })
      const content = "The user keeps a unique notebook about kestrel migrations"
      const inA = engine.remember(engine.context("proj_ga", "ses_ga"), { content, actor: "user", sessionId: "ses_ga", scope: "project" })
      const inB = engine.remember(engine.context("proj_gb", "ses_gb"), { content: "The user collects unique notes about osprey nests", actor: "user", sessionId: "ses_gb", scope: "project" })
      if (!inA.ok || !inB.ok) throw new Error("setup failed")

      const outside = await api("/api/forget", { ids: [inB.id], session: "ses_ga", confirm: true })
      expect(outside.status).toBe(404)
      expect(engine.observation(inB.id)?.status).toBe("active")

      const forgot = await api("/api/forget", { ids: [inA.id, inB.id], session: "ses_ga", confirm: true })
      expect(forgot.status).toBe(200)
      const data = JSON.parse(forgot.body).data
      expect(data.observationIds).toEqual([inA.id])
      expect(data.skipped).toEqual([inB.id])
      const elsewhere = await api("/api/remember", { content, session: "ses_gb" })
      expect(elsewhere.status).toBe(409)
    } finally {
      engine.unregister("adp_proj_ga")
      engine.unregister("adp_proj_gb")
      rmDir(dirA)
      rmDir(dirB)
    }
  })

  test("GET /api/commands/:id returns the parsed result", async () => {
    const now = Date.now()
    engine.db
      .prepare("INSERT INTO commands(directory, kind, payload, state, result, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(dir, "reflect", "{}", "done", JSON.stringify({ status: "ok", ops: 2 }), 1, now, now)
    const id = engine.db.prepare("SELECT MAX(id) AS id FROM commands").get<{ id: number }>()!.id
    const r = await api(`/api/commands/${id}`)
    expect(r.status).toBe(200)
    const data = JSON.parse(r.body).data
    expect(data.state).toBe("done")
    expect(data.result).toEqual({ status: "ok", ops: 2 })
  })

  test("flush/reflect for a project no live window owns fail fast with 409", async () => {
    const other = tempDir()
    try {
      const a = project("proj_orphan", other)
      engine.register(a as any)
      engine.trackSession(a as any, { id: "ses_orphan" })
      engine.unregister(a.id)
      const before = engine.db.prepare("SELECT COUNT(*) AS n FROM commands").get<{ n: number }>()!.n

      const flush = await api("/api/flush", { session: "ses_orphan" })
      expect(flush.status).toBe(409)
      expect(JSON.parse(flush.body).error).toBe(NO_OWNER)
      const reflect = await api("/api/reflect", { scopeKey: "project:proj_orphan" })
      expect(reflect.status).toBe(409)
      expect(engine.db.prepare("SELECT COUNT(*) AS n FROM commands").get<{ n: number }>()!.n).toBe(before)

      const now = Date.now()
      engine.db
        .prepare("INSERT INTO instances(id, pid, directory, project_id, started_at, heartbeat_at) VALUES (?,?,?,?,?,?)")
        .run("inst_elsewhere", 99999, other, "proj_orphan", now, now)
      expect(directoryOwned(engine, other)).toBe(true)
      const routed = await api("/api/flush", { session: "ses_orphan" })
      expect(routed.status).toBe(200)
      expect(JSON.parse(routed.body).data).toMatchObject({ routed: true, state: "pending" })

      engine.db.prepare("UPDATE instances SET heartbeat_at = ? WHERE id = ?").run(now - 10 * 60_000, "inst_elsewhere")
      expect(directoryOwned(engine, other)).toBe(false)
    } finally {
      engine.db.prepare("DELETE FROM instances WHERE id = ?").run("inst_elsewhere")
      engine.db.prepare("DELETE FROM commands WHERE state = 'pending'").run()
      rmDir(other)
    }
  })

  test("remember/supersede surface core's write status and message; remember validates its payload", async () => {
    const a = project("proj_write", dir)
    engine.register(a as any)
    for (const id of ["ses_write", "ses_write_gone", "ses_write_excl"]) engine.trackSession(a as any, { id })
    const fail = async (path: string, body: unknown) => {
      const r = await api(path, body)
      return { status: r.status, error: JSON.parse(r.body).error as string }
    }

    const saved = await api("/api/remember", {
      content: "The user wants tabs rendered four columns wide",
      kind: "preference",
      scope: "project",
      session: "ses_write",
      payload: { key: "Tab width", value: "4" },
    })
    expect(saved.status).toBe(200)
    const id = JSON.parse(saved.body).data.id as string
    expect(engine.observation(id)?.subject_key).toBe("pref:tab width")

    expect(await fail("/api/remember", { content: "x y z", session: "ses_write", payload: "key=value" })).toEqual({ status: 400, error: "payload must be an object" })
    const badPayload = await fail("/api/remember", { content: "Quiz on recursion", kind: "quiz-attempt", session: "ses_write", payload: { concept: "Recursion", hints: 99 } })
    expect(badPayload.status).toBe(400)
    expect(badPayload.error).toStartWith("invalid payload hints")

    expect((await api("/api/forget/session", { session: "ses_write_gone", confirm: true })).status).toBe(200)
    expect(await fail("/api/remember", { content: "The user likes short commit messages", session: "ses_write_gone" })).toEqual({
      status: 409,
      error: "this session was forgotten; nothing more is stored from it",
    })
    expect(await fail(`/api/observations/${id}/supersede`, { content: "The user wants two-column tabs", session: "ses_write_gone" })).toEqual({
      status: 409,
      error: "this session was forgotten; nothing more is stored from it",
    })
    engine.setSessionFlag("ses_write_excl", "excluded", true)
    expect(await fail("/api/remember", { content: "The user likes short commit messages", session: "ses_write_excl" })).toEqual({
      status: 409,
      error: "this session is excluded from memory; memories cannot be written to it",
    })
    expect((await fail(`/api/observations/obs_missing/supersede`, { content: "anything at all" })).status).toBe(404)
  })

  test("POST /api/config: timers under 1000 ms and an unreadable config.json are 400 and change nothing", async () => {
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    const file = join(dir, "opencode-memory", "config.json")
    const before = structuredClone(engine.config)
    try {
      for (const [patch, error] of [
        [{ runner: { timeoutMs: 500 } }, "runner.timeoutMs must be at least 1000 ms"],
        [{ reflectorRunner: { timeoutMs: 10 } }, "reflectorRunner.timeoutMs must be at least 1000 ms"],
        [{ observe: { leaseMs: 999 } }, "observe.leaseMs must be at least 1000 ms"],
      ] as const) {
        const r = await api("/api/config", { patch })
        expect({ status: r.status, error: JSON.parse(r.body).error }).toEqual({ status: 400, error })
      }
      expect(engine.config.runner.timeoutMs).toBe(before.runner.timeoutMs)
      expect(engine.config.observe.leaseMs).toBe(before.observe.leaseMs)

      mkdirSync(join(dir, "opencode-memory"), { recursive: true })
      writeFileSync(file, "{ not json")
      const broken = await api("/api/config", { patch: { inject: { deadlineMs: 777 } } })
      expect(broken.status).toBe(400)
      const error = JSON.parse(broken.body).error as string
      expect(error).toStartWith("config.json is not valid JSON")
      expect(error).not.toContain(dir)
      expect(engine.config.inject.deadlineMs).toBe(before.inject.deadlineMs)
    } finally {
      rmSync(file, { force: true })
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  })

  test("restore refusals keep their status and message and never leak the backup path", async () => {
    const backups = join(dir, "backups")
    mkdirSync(backups, { recursive: true })
    const unmarked = join(backups, "memory-20200101-000000.db")
    const empty = join(backups, "memory-20200102-000000.db")
    engine.db.exec(`VACUUM INTO '${unmarked.replace(/'/g, "''")}'`)
    writeFileSync(empty, "")
    try {
      const refused = await api("/api/backups/restore", { file: basename(unmarked), confirm: true })
      expect(refused.status).toBe(409)
      expect(JSON.parse(refused.body).error).toContain("no backup marker")
      const blank = await api("/api/backups/restore", { file: basename(empty), confirm: true })
      expect([400, 409]).toContain(blank.status)
      for (const r of [refused, blank]) {
        expect(r.body).not.toContain(backups)
        expect(r.body).not.toContain(dir)
      }
    } finally {
      rmSync(unmarked, { force: true })
      rmSync(empty, { force: true })
    }
  })

  test("OPTIONS /api is not CORS-approved", async () => {
    const r = await raw({
      port,
      path: "/api/status",
      method: "OPTIONS",
      headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example", [TOKEN_HEADER]: token },
    })
    expect(r.status).toBe(403)
    expect(r.headers["access-control-allow-origin"]).toBeUndefined()
  })

  afterAll(async () => {
    await close()
    await engine?.close()
    rmDir(dir)
  })
})

describe("http helpers and port sharing", () => {
  test("tokenEqual is exact and length-safe", () => {
    expect(tokenEqual("abc", "abc")).toBe(true)
    expect(tokenEqual("abd", "abc")).toBe(false)
    expect(tokenEqual("", "abc")).toBe(false)
    expect(tokenEqual("abcd", "abc")).toBe(false)
  })

  test("page navigation exemption only covers GET /app, /app/*, /embed", () => {
    expect(isPageNavigation("GET", "/embed", "navigate")).toBe(true)
    expect(isPageNavigation("GET", "/app/x", "navigate")).toBe(true)
    expect(isPageNavigation("POST", "/embed", "navigate")).toBe(false)
    expect(isPageNavigation("GET", "/apps", "navigate")).toBe(false)
    expect(isPageNavigation("GET", "/api/status", "navigate")).toBe(false)
    expect(isPageNavigation("GET", "/embed", "no-cors")).toBe(false)
  })

  test("engine failure messages map to 404/409/400", () => {
    expect(engineFailStatus("observation not found")).toBe(404)
    expect(engineFailStatus("this content was forgotten earlier")).toBe(409)
    expect(engineFailStatus("empty content")).toBe(400)
    expect(writeFailStatus({ error: "anything", status: 409 })).toBe(409)
    expect(writeFailStatus({ error: "instruction-like content is not stored", status: 400 })).toBe(400)
    expect(writeFailStatus({ error: "observation not found" })).toBe(404)
    expect(knownError(new MemoryError("gone", "not_found", 404))).toEqual({ status: 404, message: "gone" })
    expect(knownError(new Error("boom"))).toBeUndefined()
    expect(knownError(new Error("refusing to restore: the backup has no sessions, observations or topics"))?.status).toBe(409)
    expect(knownError(new Error("not an opencode-memory backup"))?.status).toBe(400)
  })

  test("known error messages lose absolute paths but keep the file name", () => {
    const home = homedir()
    const refused = knownError(new MemoryError(`${join(home, ".config", "opencode-memory", "config.json")} is not valid JSON; fix it`, "invalid", 400))
    expect(refused).toEqual({ status: 400, message: "config.json is not valid JSON; fix it" })
    expect(scrubPaths("fix it in C:\\Users\\me\\data\\config.json before changing it")).toBe("fix it in config.json before changing it")
    expect(scrubPaths('cannot open "/var/lib/om/backups/memory-1.db"')).toBe('cannot open "memory-1.db"')
    expect(scrubPaths("agent proposal for workspace/user scope requires human review")).toBe("agent proposal for workspace/user scope requires human review")
    expect(scrubPaths("invalid config runner.timeoutMs: Too small: expected number to be >=1000")).toBe(
      "invalid config runner.timeoutMs: Too small: expected number to be >=1000",
    )
  })

  test("a second listener on a busy port shares it and takes over when the owner exits", async () => {
    const dir = tempDir()
    const port = await freePort()
    const engine = await MemoryEngine.open({ ...defaultConfig(dir), port })
    const logs: string[] = []
    const a = await listenMemoryHttp(engine, { token: "a".repeat(64), dashboardDir: dir, log: () => {} })
    const b = await listenMemoryHttp(engine, { token: "b".repeat(64), dashboardDir: dir, log: (_l, m) => void logs.push(m), retryMs: 50 })
    try {
      expect(a.serving).toBe(true)
      expect(b.serving).toBe(false)
      expect(logs.some((m) => m.includes("already bound"))).toBe(true)
      await a.close()
      for (let i = 0; i < 60 && !b.serving; i++) await new Promise((r) => setTimeout(r, 50))
      expect(b.serving).toBe(true)
      const r = await raw({ port, path: "/health", headers: { host: `127.0.0.1:${port}` } })
      expect(r.status).toBe(200)
    } finally {
      await a.close()
      await b.close()
      await engine.close()
      rmDir(dir)
    }
  })
})
