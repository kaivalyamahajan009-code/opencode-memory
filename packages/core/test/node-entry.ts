/**
 * Core smoke test on Node's node:sqlite driver. scripts/node-check.mjs bundles this file
 * with `bun build --target node` and runs it with `node`; the first failed check exits 1.
 */
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assistantMsg, cleanupAllTempDirs, defaultConfig, FakeRunner, makeAdapter, observerOutput, putObservation, seed, tempDir, userMsg } from "./helpers"
import { MemoryEngine } from "../src/engine"
import { loadConfig, saveConfigPatch } from "../src/config"
import { cancelOpenChunks, queueChunk } from "../src/chunks"
import { applyObservationDomainHooks, scrubObservationDomain } from "../src/observer"
import { rejectObservation } from "../src/observations"
import { forgetObservations, forgetSession } from "../src/forget"
import { memoryGeneration } from "../src/inject"
import { openDatabase } from "../src/sqlite"
import { MemoryError } from "../src/util"

const passed: string[] = []

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
  } catch (e) {
    throw new Error(`${name}: ${e instanceof Error ? e.stack || e.message : String(e)}`)
  }
  passed.push(name)
}

async function waitFor(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function main() {
  const dir = tempDir()
  const engine = await MemoryEngine.open(defaultConfig(dir), () => {}, join(dir, "memory.db"))
  const db = engine.db
  try {
    await check("node driver", () => assert.equal(db.driver, "node"))

    const now = Date.now()
    const messages = [
      userMsg("I prefer dark mode in the editor", { id: "u1", sessionID: "ses_node", at: now }),
      assistantMsg("Noted, the dark theme it is.", { id: "a1", sessionID: "ses_node", at: now + 1 }),
    ]
    const runner = new FakeRunner().always(
      observerOutput([
        {
          kind: "fact",
          content: "The user prefers dark mode in the editor",
          evidenceType: "explicit",
          sources: { start: "m1", end: "m1" },
          quote: "I prefer dark mode in the editor",
        },
      ]),
    )
    const project = { id: "proj_node", workspace: "node-ws", domain: "general" as const, name: "Node", directory: dir }
    const adapter = makeAdapter(runner, { directory: dir, project, messages })
    engine.register(adapter, now)
    engine.trackSession(adapter, { id: "ses_node", title: "node check" }, now)
    const access = engine.context("proj_node", "ses_node")

    await check("ingest + cut + claim + commit", async () => {
      assert.ok(engine.ingest("ses_node", messages, { now }))
      const flushed = await engine.flush("ses_node", { wait: true, timeoutMs: 10_000 })
      assert.ok(flushed.outcomes.some((o) => o.status === "succeeded"), JSON.stringify(flushed.outcomes))
      assert.ok(runner.requests.length >= 1)
      const n = db.prepare("SELECT COUNT(*) AS n FROM observations WHERE content LIKE '%dark mode%'").get<{ n: number }>()!.n
      assert.ok(n >= 1, "no observation committed")
    })

    await check("FTS search", () => {
      assert.equal(db.hasFts5, true)
      assert.ok(engine.search(access, "dark mode").some((h) => h.row.content.includes("dark mode")))
    })

    await check("routeCommand / processCommands", async () => {
      const routed = await engine.routeCommand(dir, "observe", {})
      const id = (routed as { commandId: number }).commandId
      assert.ok(id > 0)
      await waitFor(() => engine.commandStatus(id)?.state === "done")
      db.prepare("INSERT INTO commands(directory, kind, payload, state, created_at, updated_at) VALUES (?, 'flush', ?, 'pending', ?, ?)").run(
        dir,
        JSON.stringify({ sessionId: "ses_node" }),
        Date.now(),
        Date.now(),
      )
      const queued = db.prepare("SELECT last_insert_rowid() AS id").get<{ id: number }>()!.id
      assert.equal(await engine.processCommands(), 1)
      await waitFor(() => engine.commandStatus(queued)?.state === "done")
      const remote = await engine.routeCommand(join(dir, "elsewhere"), "flush", { sessionId: "ses_node" })
      assert.equal(remote.routed, true)
    })

    await check("runtime_state pause/resume", () => {
      engine.setPaused(true)
      assert.equal(engine.paused, true)
      assert.equal(engine.pausedReason(), "manual")
      engine.setPaused(false)
      assert.equal(engine.paused, false)
      assert.equal(engine.pausedReason(), null)
    })

    await check("revive revert-cancelled chunk", () => {
      const state = (id: string) => db.prepare("SELECT state FROM chunks WHERE id = ?").get<{ state: string }>(id)!.state
      const input = { sessionId: "ses_node", projectId: "proj_node", startSeq: 90, endSeq: 91, tokenEst: 5, reason: "explicit", now: Date.now() }
      const id = queueChunk(db, input)
      cancelOpenChunks(db, "ses_node", { reason: "revert", ranges: [[90, 91]] })
      assert.equal(state(id), "cancelled")
      assert.equal(queueChunk(db, input), id)
      assert.equal(state(id), "pending")
      cancelOpenChunks(db, "ses_node", { reason: "forget", ranges: [[90, 91]] })
      queueChunk(db, input)
      assert.equal(state(id), "cancelled")
    })

    await check("config save/load round-trip", () => {
      const path = join(dir, "config.json")
      assert.equal(saveConfigPatch({ observe: { minFlushTokens: 42 }, inject: { budget: { recall: 123 } } }, path).observe.minFlushTokens, 42)
      assert.equal(loadConfig(path).inject.budget.recall, 123)
      assert.throws(() => saveConfigPatch(JSON.parse('{"__proto__": {"port": 1}}'), path), MemoryError)
      assert.equal(loadConfig(path).port, 4777)
    })

    await check("config save keeps an invalid section and runner secrets", () => {
      const path = join(dir, "config-invalid.json")
      const runner = { kind: "direct", direct: { baseURL: "https://llm.internal.example/v1", apiKeyEnv: "MY_LLM_KEY", model: "m-1" } }
      writeFileSync(path, JSON.stringify({ observe: { leaseMs: "bad" }, runner }))
      saveConfigPatch({ reflect: { minNewDurable: 5 } }, path)
      const raw = JSON.parse(readFileSync(path, "utf8"))
      assert.deepEqual(raw.observe, { leaseMs: "bad" })
      assert.deepEqual(raw.runner, runner)
      assert.throws(() => saveConfigPatch({ observe: { leaseMs: 0 } }, path), MemoryError)
    })

    await check("research source with _ in its URL survives reject cleanup", () => {
      const url = "https://example.org/widget_paper_v2"
      const mk = (kind: string, content: string) => {
        const id = putObservation(db, { workspace: "node-ws", projectId: "proj_node", scopeKind: "workspace", kind, content, payload: { url } }).id
        applyObservationDomainHooks(db, id)
        return id
      }
      mk("source", "The widget benchmark methodology paper")
      const claim = mk("claim", "Widget caching halves latency")
      const sources = () => db.prepare("SELECT COUNT(*) AS n FROM research_sources WHERE workspace = 'node-ws'").get<{ n: number }>()!.n
      assert.equal(sources(), 1)
      rejectObservation(db, claim)
      scrubObservationDomain(db, claim)
      assert.equal(sources(), 1)
    })

    await check("foreign pending commands do not starve a local one", async () => {
      const now = Date.now()
      const insert = db.prepare("INSERT INTO commands(directory, kind, payload, state, created_at, updated_at) VALUES (?, 'observe', '{}', 'pending', ?, ?)")
      for (let i = 0; i < 25; i++) insert.run(join(dir, "elsewhere"), now, now)
      insert.run(dir, now, now)
      const local = db.prepare("SELECT MAX(id) AS id FROM commands").get<{ id: number }>()!.id
      assert.equal(await engine.processCommands(now), 1)
      await waitFor(() => engine.commandStatus(local)?.state === "done")
    })

    await check("forgotten session refuses un-exclude and writes", () => {
      engine.trackSession(adapter, { id: "ses_gone", title: "gone" }, Date.now())
      forgetSession(db, "ses_gone", "user")
      assert.throws(
        () => engine.setSessionFlag("ses_gone", "excluded", false),
        (e: unknown) => e instanceof MemoryError && e.status === 409,
      )
      const r = engine.remember(engine.context("proj_node", "ses_gone"), { content: "The user likes jazz", actor: "user" })
      assert.equal(r.ok, false)
      assert.equal(!r.ok && r.status, 409)
    })

    await check("scoped forget suppresses only inside its scope", () => {
      seed(db, { workspace: "node-ws", projectId: "proj_node2", sessionId: "ses_node2", directory: join(dir, "two") })
      const text = "The node staging box reboots every Sunday"
      const put = (projectId: string) => putObservation(db, { workspace: "node-ws", projectId, content: text }).result.outcome
      const a = putObservation(db, { workspace: "node-ws", projectId: "proj_node", content: text })
      forgetObservations(db, [a.id], { actor: "agent", reason: "agent forget", ctx: { projectId: "proj_node", workspace: "node-ws", sessionId: "ses_node" } })
      assert.equal(put("proj_node"), "suppressed")
      const b = putObservation(db, { workspace: "node-ws", projectId: "proj_node2", content: text })
      assert.equal(b.result.outcome, "inserted")
      forgetObservations(db, [b.id], { actor: "user", reason: "user forget" })
      assert.equal(put("proj_node2"), "suppressed")
      assert.equal(put("proj_node"), "suppressed")
    })

    await check("memory generation is visible to a second connection", async () => {
      const other = await openDatabase(join(dir, "memory.db"))
      try {
        const id = putObservation(db, { workspace: "node-ws", projectId: "proj_node", content: "The node release train leaves on Fridays" }).id
        const before = memoryGeneration(other)
        engine.pin(id, true)
        const pinned = memoryGeneration(other)
        assert.ok(pinned > before, `pin: ${pinned} <= ${before}`)
        await engine.forget([id], { actor: "user", reason: "node check" })
        assert.ok(memoryGeneration(other) > pinned, "forget did not bump")
        assert.equal(engine.memoryGeneration(), memoryGeneration(other))
      } finally {
        other.close()
      }
    })
  } finally {
    await engine.close()
    cleanupAllTempDirs()
  }
  console.log(`node-check ok (${passed.length} checks: ${passed.join(", ")})`)
}

main().catch((e) => {
  console.error(`node-check failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
