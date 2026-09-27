import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import {
  fetchBackups,
  fetchCommand,
  fetchRecall,
  fetchReview,
  fetchStatus,
  flushSession,
  forgetCandidates,
  forgetObservations,
  forgetSession,
  patchConfig,
  remember,
  restoreBackup,
  setPaused,
  setSessionFlags,
  supersedeObservation,
} from "../src/api"
import { ApiError } from "../src/api-unwrap"
import { flushErrorText, parseCommandStatus, parseFlushResponse } from "../src/commands"
import { FORGOTTEN_SESSION_TEXT, restoreErrorText, sessionFlagErrorText, writeErrorText } from "../src/errors"
import { forgetBody, forgetFailure, forgetOutcome, forgetRequest } from "../src/forget-select"
import { mergeRecall, nextRecallRequest, recallRequestFor } from "../src/recall"
import { bulkableIds } from "../src/review-bulk"
import { canEditReview, isVaultConflict, reviewText } from "../src/review-kind"
import { buildSettingsPatch, serverFieldError } from "../src/settings-fields"
import { activePauseReason, pausedBannerText, pauseReason } from "../src/status"
import type { RecallOk } from "../src/types"

/**
 * Runs the dashboard's api.ts, parsers and formatters against the real plugin HTTP handler over a
 * temp-dir engine. Loaded by variable path so the dashboard typecheck does not pull in plugin/core sources.
 */
const CORE_HELPERS = "../../core/test/helpers.ts"
const PLUGIN_HTTP = "../../plugin/src/server/http.ts"

type Db = { prepare(sql: string): { run(...args: unknown[]): unknown }; exec(sql: string): void }
type Engine = {
  db: Db
  config: { dataDir: string }
  register(adapter: unknown, now?: number): void
  trackSession(adapter: unknown, meta: { id: string }, now?: number): void
  ingest(sessionId: string, messages: unknown[], opts?: { now?: number }): unknown
}
type Env = { engine: Engine; dir: string; close(): Promise<void> }

const token = "c".repeat(64)
const saved = { fetch: globalThis.fetch, document: (globalThis as { document?: unknown }).document }
let env: Env
let helpers: any
let closeHttp: () => Promise<void> = async () => {}

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run()
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error("expected the request to be refused")
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

beforeAll(async () => {
  helpers = await import(CORE_HELPERS)
  const http = await import(PLUGIN_HTTP)
  const port = await freePort()
  env = await helpers.openEngine({ patch: { port, allowedOrigins: [] } })
  const db = env.engine.db
  helpers.seed(db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" })
  helpers.seed(db, { projectId: "proj_b", workspace: "research", sessionId: "ses_b" })
  for (const sessionId of ["ses_gone", "ses_excl", "ses_recall"]) helpers.seed(db, { projectId: "proj_a", workspace: "learn", sessionId })
  helpers.putObservation(db, { id: "obs_a", scopeKind: "session", sessionId: "ses_a", projectId: "proj_a", workspace: "learn", content: "Prefers dark mode in the editor" })
  helpers.putObservation(db, { id: "obs_b", scopeKind: "project", sessionId: "ses_b", projectId: "proj_b", workspace: "research", content: "Prefers dark mode in the terminal" })
  helpers.putObservation(db, {
    id: "obs_p",
    scopeKind: "session",
    sessionId: "ses_b",
    projectId: "proj_b",
    workspace: "research",
    kind: "demonstrated-skill",
    status: "pending_review",
    reviewReason: "mastery claims require human review",
    content: "Mastered recursion",
  })
  db.prepare("INSERT INTO review_items(id, kind, ref_id, reason, state, data, created_at) VALUES (?,?,?,?,?,?,?)").run(
    "rev_vault",
    "vault-conflict",
    "top_x",
    "the topic file was edited outside opencode-memory",
    "open",
    JSON.stringify({ path: "concepts/x.md", generation: 1 }),
    Date.now(),
  )
  const served = await http.listenMemoryHttp(env.engine, { token, dashboardDir: helpers.tempDir(), log: () => {} })
  if (!served) throw new Error("plugin HTTP server did not start")
  closeHttp = () => served.close()
  const base = `http://127.0.0.1:${served.port}`
  ;(globalThis as { document?: unknown }).document = {
    querySelector: (sel: string) => (sel.includes("om-token") ? { getAttribute: () => token } : null),
  }
  globalThis.fetch = ((input: string, init?: RequestInit) => saved.fetch(base + input, init)) as typeof fetch
})

afterAll(async () => {
  globalThis.fetch = saved.fetch
  ;(globalThis as { document?: unknown }).document = saved.document
  await closeHttp()
  await env?.close()
})

describe("contract: review rows", () => {
  test("vault conflicts come back as { kind: null, review_kind } and are recognised", async () => {
    const items = await fetchReview("open")
    const vault = items.find((r) => r.id === "rev_vault")!
    const obs = items.find((r) => r.ref_id === "obs_p")!
    expect(vault.kind).toBeNull()
    expect(vault.review_kind).toBe("vault-conflict")
    expect(isVaultConflict(vault)).toBe(true)
    expect(canEditReview(vault)).toBe(false)
    expect(reviewText(vault)).toBe("the topic file was edited outside opencode-memory (concepts/x.md)")
    expect(obs.kind).toBe("demonstrated-skill")
    expect(isVaultConflict(obs)).toBe(false)
    expect(bulkableIds(items, Object.fromEntries(items.map((r) => [r.id, true])))).toEqual([obs.id])
  })
})

describe("contract: pause", () => {
  test("a user pause reads back as 'manual' and shows no warning banner", async () => {
    await setPaused(true)
    const paused = await fetchStatus()
    expect(paused.global.pausedReason).toBe("manual")
    expect(pauseReason(paused.global)).toBe("manual")
    expect(activePauseReason(paused.global)).toBeUndefined()
    expect(pausedBannerText(paused.global)).toBe("")
    await setPaused(false)
    const resumed = await fetchStatus()
    expect(resumed.global.paused).toBe(false)
    expect(pauseReason(resumed.global)).toBeUndefined()
  })
})

describe("contract: forget", () => {
  test("candidates without a session are not limited to one project, and parse as { id, content, score }", async () => {
    const cands = await forgetCandidates("Prefers dark mode")
    expect(cands.map((c) => c.id).sort()).toEqual(["obs_a", "obs_b"])
    for (const c of cands) {
      expect(typeof c.id).toBe("string")
      expect(typeof c.content).toBe("string")
      expect(typeof c.score).toBe("number")
    }
  })

  test("a global forget reaches other projects' rows and pending rows of other sessions", async () => {
    const result = await forgetObservations(forgetBody(forgetRequest("obs_b", ["obs_p"])))
    const outcome = forgetOutcome(["obs_b", "obs_p"], result)
    expect([...result.observationIds].sort()).toEqual(["obs_b", "obs_p"])
    expect(result.skipped).toEqual([])
    expect(outcome).toMatchObject({ tone: "ok", complete: true, changed: true, forgot: 2, skipped: 0 })
  })

  test("forgetting the same rows again is a 404 that the dialog reports and refreshes on", async () => {
    let caught: unknown
    try {
      await forgetObservations(forgetBody(forgetRequest("obs_b", [])))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).status).toBe(404)
    expect(forgetFailure(caught)).toMatchObject({ tone: "warn", changed: true, complete: false })
  })
})

describe("contract: flush and commands", () => {
  test("a flush nobody can run is a 409 with its own explanation", async () => {
    let caught: unknown
    try {
      await flushSession("ses_a")
    } catch (e) {
      caught = e
    }
    expect((caught as ApiError).status).toBe(409)
    expect(flushErrorText(caught)).toContain("no open OpenCode window has this project")
  })

  test("a flush for another live window is queued and its command is pollable", async () => {
    env.engine.db
      .prepare("INSERT INTO instances(id, pid, server_url, directory, project_id, started_at, heartbeat_at) VALUES (?,?,?,?,?,?,?)")
      .run("inst_other", 4242, null, "/tmp/proj_a", "proj_a", Date.now(), Date.now())
    const start = parseFlushResponse(await flushSession("ses_a"))
    expect(start.kind).toBe("queued")
    if (start.kind !== "queued") return
    const status = parseCommandStatus(await fetchCommand(start.commandId))
    expect(status).toMatchObject({ id: start.commandId, state: "pending" })
    let caught: unknown
    try {
      await fetchCommand(start.commandId + 1000)
    } catch (e) {
      caught = e
    }
    expect((caught as ApiError).status).toBe(404)
  })
})

describe("contract: writes and session flags", () => {
  test("remember refuses a bad payload with 400 and shows the server's reason", async () => {
    const notObject = await refusal(() => remember({ content: "The user practises recursion daily", scope: "session", session: "ses_a", payload: [] as never }))
    expect(notObject.status).toBe(400)
    expect(writeErrorText(notObject)).toBe("Payload must be an object")
    const bad = await refusal(() =>
      remember({ content: "Quiz on recursion", kind: "quiz-attempt", scope: "session", session: "ses_a", payload: { concept: "Recursion", hints: 99 } }),
    )
    expect(bad.status).toBe(400)
    expect(writeErrorText(bad)).toStartWith("Invalid payload hints")
  })

  test("an excluded session refuses remember with 409 until it is included again", async () => {
    await setSessionFlags("ses_excl", { excluded: true })
    const blocked = await refusal(() => remember({ content: "The user likes short commit messages", scope: "session", session: "ses_excl" }))
    expect(blocked.status).toBe(409)
    expect(writeErrorText(blocked)).toContain("excluded from memory")
    await setSessionFlags("ses_excl", { excluded: false })
    const saved = await remember({ content: "The user likes short commit messages", scope: "session", session: "ses_excl" })
    expect(typeof saved.id).toBe("string")
  })

  test("a forgotten session reads back forgotten, refuses remember/supersede with 409 and can't be re-included", async () => {
    await forgetSession("ses_gone")
    const status = await fetchStatus("ses_gone")
    expect(status.session?.forgotten).toBe(true)
    expect(status.session?.excluded).toBe(true)

    const write = await refusal(() => remember({ content: "The user prefers tabs over spaces", scope: "session", session: "ses_gone" }))
    expect(write.status).toBe(409)
    expect(writeErrorText(write)).toBe("This session was forgotten, so nothing more can be stored from it.")

    helpers.putObservation(env.engine.db, { id: "obs_gone", scopeKind: "user", sessionId: "ses_gone", projectId: "proj_a", workspace: "learn", content: "Uses a split keyboard" })
    const sup = await refusal(() => supersedeObservation("obs_gone", "Uses an ergonomic split keyboard", "dashboard"))
    expect(sup.status).toBe(409)
    expect(writeErrorText(sup)).toBe("This session was forgotten, so nothing more can be stored from it.")

    const include = await refusal(() => setSessionFlags("ses_gone", { excluded: false, paused: true }))
    expect(include.status).toBe(409)
    expect(sessionFlagErrorText(include)).toBe(FORGOTTEN_SESSION_TEXT)
    const after = await fetchStatus("ses_gone")
    expect(after.session).toMatchObject({ forgotten: true, excluded: true, paused: false })
  })
})

describe("contract: config timers", () => {
  test("a timer under 1000 ms is refused client-side and by the server with 400, placed under its field", async () => {
    const draft = {
      activationTokens: "30000",
      bufferTokens: "6000",
      reflectTokens: "40000",
      dailyCapUsd: "1",
      dailyTokenCap: "2000000",
      runnerKind: "opencode-session",
      providerID: "",
      modelID: "",
      budgetSession: "2400",
      budgetRecall: "900",
      pruning: false,
      keepRecentTurns: "4",
      runnerTimeoutMs: "500",
    }
    const local = buildSettingsPatch(draft, undefined)
    expect(local.ok).toBe(false)
    if (!local.ok) expect(local.errors.runnerTimeoutMs).toBe("Must be at least 1000 ms")
    for (const [patch, key] of [
      [{ runner: { timeoutMs: 500 } }, "runnerTimeoutMs"],
      [{ reflectorRunner: { timeoutMs: 999 } }, "reflectorTimeoutMs"],
      [{ observe: { leaseMs: 1 } }, "leaseMs"],
    ] as const) {
      const e = await refusal(() => patchConfig(patch))
      expect(e.status).toBe(400)
      expect(e.message).toContain("must be at least 1000 ms")
      expect(serverFieldError(e.message)?.key).toBe(key)
    }
  })
})

describe("contract: recall cursor", () => {
  test("Load more echoes the observation cursor (context, observationId) and pages through every cited window", async () => {
    const T0 = helpers.T0 as number
    const adapter = helpers.makeAdapter(new helpers.FakeRunner().always({ observations: [] }), { directory: env.dir })
    env.engine.register(adapter, T0)
    env.engine.trackSession(adapter, { id: "ses_recall" }, T0)
    const messages = Array.from({ length: 10 }, (_, i) =>
      helpers.userMsg(helpers.textOfTokens(7_500, `w${i + 1}`), { id: `u${i + 1}`, sessionID: "ses_recall", at: T0 + i }),
    )
    env.engine.ingest("ses_recall", messages, { now: T0 })
    const { id } = helpers.putObservation(env.engine.db, {
      workspace: "learn",
      projectId: "proj_a",
      sessionId: "ses_recall",
      content: "Cites turns two and nine",
      sources: [
        { sessionId: "ses_recall", startMessageId: "u2", endMessageId: "u2", startSeq: 2, endSeq: 2, transformVersion: 1 },
        { sessionId: "ses_recall", startMessageId: "u9", endMessageId: "u9", startSeq: 9, endSeq: 9, transformVersion: 1 },
      ],
    })

    const first = await fetchRecall(recallRequestFor({ id, session_id: "ses_recall", project_id: "proj_a" }))
    if (!first.ok) throw new Error(first.error)
    const pages = [first.messages.map((m) => m.seq)]
    let shown: RecallOk = first
    for (let i = 0; i < 10; i++) {
      const cursor = shown.nextCursor
      const req = nextRecallRequest(shown)
      if (!cursor || !req) break
      expect(cursor).toMatchObject({ sessionId: "ses_recall", observationId: id, context: 1 })
      expect(req).toMatchObject({ observation: cursor.observationId, from: cursor.fromSeq, to: cursor.toSeq, context: cursor.context })
      const next = await fetchRecall(req)
      if (!next.ok) throw new Error(next.error)
      pages.push(next.messages.map((m) => m.seq))
      shown = mergeRecall(shown, next).result
    }
    expect(pages).toEqual([[1, 2, 3], [8, 9], [10]])
    expect(shown.messages.map((m) => m.seq)).toEqual([1, 2, 3, 8, 9, 10])
    expect(nextRecallRequest(shown)).toBeUndefined()
  })
})

describe("contract: restore refusals", () => {
  test("an unmarked backup is refused with 409 and the dialog shows the server's reason", async () => {
    const file = "memory-20200101-000000.db"
    const backups = join(env.engine.config.dataDir, "backups")
    mkdirSync(backups, { recursive: true })
    env.engine.db.exec(`VACUUM INTO '${join(backups, file).replace(/'/g, "''")}'`)
    expect((await fetchBackups()).map((b) => b.file)).toContain(file)
    const e = await refusal(() => restoreBackup(file))
    expect(e.status).toBe(409)
    expect(restoreErrorText(e)).toBe("Restore failed: refusing to restore: the file has no backup marker")
    expect(e.message).not.toContain(backups)
  })
})
