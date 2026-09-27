import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  FakeRunner,
  T0,
  assistantMsg,
  cleanupAllTempDirs,
  ingest,
  makeAdapter,
  openDb,
  openEngine,
  openHarness,
  putObservation,
  seed,
  textPart,
  track,
  userMsg,
} from "./helpers"
import { applySuppressions, forgetObservations, forgetSession } from "../src/forget"
import { applyPromotion } from "../src/reflector"
import {
  approveObservation,
  FORGOTTEN_CONTENT,
  getObservation,
  observationEvents,
  openReview,
  supersedeObservation,
} from "../src/observations"
import { buildMemoryBlock, memoryGeneration } from "../src/inject"
import { recordForkLineage } from "../src/lifecycle"
import { backupDir, backupNow, restoreBackup } from "../src/backup"
import { SCHEMA_VERSION } from "../src/schema-sql"
import { openDatabase } from "../src/sqlite"
import { upsertProject, upsertSession } from "../src/ingest"
import { applyObservationDomainHooks } from "../src/observer"
import { materializeOutbox, resolveVaultConflict, scanExternalEdits, upsertTopic } from "../src/vault"
import { MemoryError } from "../src/util"

afterAll(cleanupAllTempDirs)

const SECRET = `ghp_${"b".repeat(36)}`

function caught(fn: () => unknown): Error & { status?: number } {
  try {
    fn()
  } catch (e) {
    return e as Error & { status?: number }
  }
  throw new Error("expected a throw")
}

describe("review round 4", () => {
  test("a scoped forget blocks the same text only inside its boundary; a user forget blocks everywhere (item 1)", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { workspace: "w1", projectId: "p1", sessionId: "s1" })
      seed(h.db, { workspace: "w1", projectId: "p2", sessionId: "s2" })
      seed(h.db, { workspace: "w2", projectId: "p3", sessionId: "s3" })
      const scoped = "The staging cluster restarts every night at two"
      const global = "The quarterly offsite is booked at the lake house"
      const a = putObservation(h.db, { workspace: "w1", projectId: "p1", content: scoped })
      forgetObservations(h.db, [a.id], { actor: "agent", reason: "agent forget", ctx: { projectId: "p1", workspace: "w1", sessionId: "s1" } })
      const b = putObservation(h.db, { workspace: "w2", projectId: "p3", content: global })
      forgetObservations(h.db, [b.id], { actor: "user", reason: "user forget" })

      const put = (projectId: string, workspace: string, content: string, extra: Partial<Parameters<typeof putObservation>[1]> = {}) =>
        putObservation(h.db, { workspace, projectId, content, ...extra }).result.outcome
      expect(put("p1", "w1", scoped)).toBe("suppressed")
      expect(put("p2", "w1", scoped)).toBe("inserted")
      expect(put("p3", "w2", scoped)).toBe("inserted")
      // A pending row is checked at the scope it is proposed for: a workspace-wide row would reach p1.
      const pending = { scopeKind: "session" as const, status: "pending_review", targetScope: "workspace", actor: "user" }
      expect(put("p2", "w1", scoped, { ...pending, sessionId: "s2" })).toBe("suppressed")
      expect(put("p3", "w2", scoped, { ...pending, sessionId: "s3" })).toBe("inserted")
      for (const [p, w] of [
        ["p1", "w1"],
        ["p2", "w1"],
        ["p3", "w2"],
      ])
        expect(put(p, w, global)).toBe("suppressed")
    } finally {
      h.close()
    }
  })

  test("engine remember/supersede check where the row lands and refuse with one wording (item 1)", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      seed(db, { workspace: "w1", projectId: "p1", sessionId: "s1" })
      seed(db, { workspace: "w1", projectId: "p2", sessionId: "s2" })
      seed(db, { workspace: "w2", projectId: "p3", sessionId: "s3" })
      const ctx = (projectId: string, workspace: string, sessionId: string) => ({ projectId, workspace, sessionId })
      const text = "The release train leaves every second Thursday"
      const a = putObservation(db, { workspace: "w1", projectId: "p1", content: text })
      await env.engine.forget([a.id], { actor: "agent", reason: "agent forget", ctx: ctx("p1", "w1", "s1") })

      expect(env.engine.remember(ctx("p1", "w1", "s1"), { content: text, actor: "user", scope: "project" })).toMatchObject({
        ok: false,
        status: 409,
        error: FORGOTTEN_CONTENT,
      })
      expect(env.engine.remember(ctx("p2", "w1", "s2"), { content: text, actor: "user", scope: "project" }).ok).toBe(true)
      expect(env.engine.remember(ctx("p3", "w2", "s3"), { content: text, actor: "agent" }).ok).toBe(true)

      const plants = "The office plants are watered on Monday mornings"
      const g = putObservation(db, { workspace: "w2", projectId: "p3", content: plants })
      await env.engine.forget([g.id], { actor: "user", reason: "user forget" })
      expect(env.engine.remember(ctx("p2", "w1", "s2"), { content: plants, actor: "user", scope: "project" })).toMatchObject({
        ok: false,
        status: 409,
        error: FORGOTTEN_CONTENT,
      })

      const inP2 = putObservation(db, { workspace: "w1", projectId: "p2", content: "Deploys happen on Friday afternoons" })
      expect(env.engine.supersede(undefined, inP2.id, text, "schedule changed", "user").ok).toBe(true)
      const inP1 = putObservation(db, { workspace: "w1", projectId: "p1", content: "Deploys happen on Monday mornings" })
      expect(env.engine.supersede(undefined, inP1.id, text, "schedule changed", "user")).toMatchObject({ ok: false, status: 409, error: FORGOTTEN_CONTENT })
    } finally {
      await env.close()
    }
  })

  test("a promotion or widening approval into a scope where the content is forgotten is refused (item 2)", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { workspace: "w1", projectId: "p1", sessionId: "s1" })
      seed(h.db, { workspace: "w1", projectId: "p1", sessionId: "s1b" })
      seed(h.db, { workspace: "w1", projectId: "p2", sessionId: "s2" })
      const text = "The integration suite needs the VPN to be connected"
      const mine = putObservation(h.db, { workspace: "w1", projectId: "p1", content: text })
      const wide = putObservation(h.db, {
        workspace: "w1",
        projectId: "p1",
        scopeKind: "session",
        sessionId: "s1",
        content: text,
        status: "pending_review",
        targetScope: "workspace",
        actor: "user",
      })
      const narrow = putObservation(h.db, {
        workspace: "w1",
        projectId: "p1",
        scopeKind: "session",
        sessionId: "s1b",
        content: text,
        status: "pending_review",
        targetScope: "project",
        actor: "user",
      })
      const theirs = putObservation(h.db, { workspace: "w1", projectId: "p2", content: text })
      forgetObservations(h.db, [theirs.id], { actor: "agent", reason: "agent forget", ctx: { projectId: "p2", workspace: "w1", sessionId: "s2" } })
      expect(getObservation(h.db, mine.id)?.status).toBe("active")

      const review = openReview(h.db, "promotion", mine.id, "useful everywhere", { scope: "workspace" })
      expect(applyPromotion(h.db, review)).toBe(false)
      expect(getObservation(h.db, mine.id)).toMatchObject({ scope_kind: "project", status: "active" })
      expect(observationEvents(h.db, mine.id).map((e: { type: string }) => e.type)).toContain("promotion-refused")
      expect(h.db.prepare("SELECT state FROM review_items WHERE id = ?").get<{ state: string }>(review)?.state).toBe("rejected")

      const other = putObservation(h.db, { workspace: "w1", projectId: "p1", content: "Lint runs before every commit in this repository" })
      const ok = openReview(h.db, "promotion", other.id, "useful everywhere", { scope: "workspace" })
      expect(applyPromotion(h.db, ok)).toBe(true)
      expect(getObservation(h.db, other.id)?.scope_kind).toBe("workspace")

      const e = caught(() => approveObservation(h.db, wide.id))
      expect(e).toBeInstanceOf(MemoryError)
      expect(e.status).toBe(409)
      expect(getObservation(h.db, wide.id)?.status).toBe("pending_review")
      expect(approveObservation(h.db, narrow.id)).toBe(true)
      expect(getObservation(h.db, narrow.id)).toMatchObject({ status: "active", scope_kind: "project" })
    } finally {
      h.close()
    }
  })

  test("supersede reasons are redacted, and dropped when they match forgotten content (item 3)", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      const { workspace, projectId } = seed(db)
      const eventsOf = (...ids: string[]) => JSON.stringify(ids.flatMap((id) => observationEvents(db, id)))

      const row = putObservation(db, { workspace, projectId, content: "The CI token lives in the team vault" })
      const r = env.engine.supersede(undefined, row.id, "The CI token moved to the new secrets manager", `rotated after leaking ${SECRET}`, "user")
      expect(r.ok).toBe(true)
      const dashboard = eventsOf(row.id, r.ok ? r.id : "")
      expect(dashboard).not.toContain(SECRET)
      expect(dashboard).toContain("rotated after leaking")

      const pref = putObservation(db, { workspace, projectId, kind: "preference", content: "The user prefers tabs for indentation", payload: { key: "indent" } })
      const successor = supersedeObservation(db, pref.id, { content: "The user prefers spaces for indentation", reason: `told me so ${SECRET}`, actor: "agent" })
      expect(successor).toBeTruthy()
      expect(getObservation(db, successor!)?.status).toBe("pending_review")
      expect(approveObservation(db, successor!)).toBe(true)
      expect(getObservation(db, pref.id)?.status).toBe("superseded")
      expect(eventsOf(pref.id, successor!)).not.toContain(SECRET)

      const forgotten = "My gym locker code is four four one seven"
      const f = putObservation(db, { workspace, projectId, content: forgotten })
      await env.engine.forget([f.id], { actor: "user", reason: "user forget" })
      const standup = putObservation(db, { workspace, projectId, content: "The standup moved to ten" })
      const next = supersedeObservation(db, standup.id, { content: "The standup moved to half past ten", reason: forgotten })
      expect(next).toBeTruthy()
      const superseded = observationEvents(db, standup.id).find((e: { type: string }) => e.type === "superseded")
      expect(JSON.parse(superseded.data).reason).toBe("")
      expect(eventsOf(standup.id, next!)).not.toContain("locker")
    } finally {
      await env.close()
    }
  })

  test("a fork made after its source was forgotten stores the copies as forgotten (item 4)", async () => {
    const h = await openHarness()
    try {
      for (const s of ["src", "fork", "fork4"]) seed(h.db, { sessionId: s })
      const secret = "My passport number is zq-fork-4471 and it expires soon"
      ingest(h.db, "src", [userMsg(secret, { id: "m1", sessionID: "src" }), assistantMsg("Noted, zq-fork-4471.", { id: "a1", sessionID: "src", at: T0 + 1 })])
      forgetSession(h.db, "src", "user")

      recordForkLineage(h.db, "fork", { sourceSessionID: "src", messages: { m1: "m1f", a1: "a1f" } }, T0)
      ingest(h.db, "fork", [
        userMsg(secret, { id: "m1f", sessionID: "fork" }),
        assistantMsg("Noted, zq-fork-4471.", { id: "a1f", sessionID: "fork", at: T0 + 1 }),
        userMsg("A new question asked after the fork", { id: "m2f", sessionID: "fork", at: T0 + 2 }),
      ])
      const partOf = (msg: string) =>
        h.db.prepare("SELECT id, text, suppressed FROM source_parts WHERE message_id = ?").get<{ id: string; text: string; suppressed: number }>(msg)!
      expect(partOf("m1f")).toMatchObject({ text: "[forgotten]", suppressed: 1 })
      expect(partOf("a1f")).toMatchObject({ text: "[forgotten]", suppressed: 1 })
      expect(partOf("m2f")).toMatchObject({ text: "A new question asked after the fork", suppressed: 0 })
      expect(h.db.prepare("SELECT 1 FROM suppressions WHERE kind = 'part' AND value = ?").get(partOf("m1f").id)).toBeTruthy()

      // Copied before the lineage arrived: recording it purges the copy.
      ingest(h.db, "fork4", [userMsg(secret, { id: "m1h", sessionID: "fork4" })])
      expect(partOf("m1h").suppressed).toBe(0)
      recordForkLineage(h.db, "fork4", { sourceSessionID: "src", messages: { m1: "m1h" } }, T0)
      expect(partOf("m1h")).toMatchObject({ text: "[forgotten]", suppressed: 1 })
      expect(JSON.stringify(h.db.prepare("SELECT text FROM source_parts").all())).not.toMatch(/zq-fork/)
    } finally {
      h.close()
    }
  })

  test("a fork copy of a purged part is forgotten through part lineage or the same-hash part of its message (item 4)", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId } = seed(h.db, { sessionId: "src2" })
      for (const s of ["fork2", "fork3", "fork5"]) seed(h.db, { sessionId: s })
      const secret = "The garage door code is zq-part-9921"
      const ok = "We also talked about the weather this week"
      const msg = (id: string, sessionID: string, suffix: string) =>
        userMsg("", { id, sessionID, parts: [textPart(secret, `sec_${suffix}`), textPart(ok, `ok_${suffix}`)] })
      ingest(h.db, "src2", [msg("n1", "src2", "src")])
      const o = putObservation(h.db, {
        workspace,
        projectId,
        sessionId: "src2",
        content: "The user shared their garage door code",
        sources: [{ sessionId: "src2", startMessageId: "n1", endMessageId: "n1", startSeq: 1, endSeq: 1, partIds: ["sec_src"], transformVersion: 1 }],
      })
      forgetObservations(h.db, [o.id], { actor: "user", reason: "user forget", purgeSources: "sources" })
      const part = (id: string) => h.db.prepare("SELECT text, suppressed FROM source_parts WHERE id = ?").get<{ text: string; suppressed: number }>(id)!

      recordForkLineage(h.db, "fork2", { sourceSessionID: "src2", messages: { n1: "n1f" }, parts: { sec_src: "sec_f2", ok_src: "ok_f2" } }, T0)
      ingest(h.db, "fork2", [msg("n1f", "fork2", "f2")])
      expect(part("sec_f2")).toMatchObject({ text: "[forgotten]", suppressed: 1 })
      expect(part("ok_f2")).toMatchObject({ text: ok, suppressed: 0 })

      recordForkLineage(h.db, "fork3", { sourceSessionID: "src2", messages: { n1: "n1g" } }, T0)
      ingest(h.db, "fork3", [msg("n1g", "fork3", "f3")])
      expect(part("sec_f3").suppressed).toBe(1)
      expect(part("ok_f3").suppressed).toBe(0)

      // A fork of the fork follows the chain back to the purged source part.
      recordForkLineage(h.db, "fork5", { sourceSessionID: "fork3", messages: { n1g: "n1k" } }, T0)
      ingest(h.db, "fork5", [msg("n1k", "fork5", "f5")])
      expect(part("sec_f5").suppressed).toBe(1)
      expect(part("ok_f5").suppressed).toBe(0)
      expect(JSON.stringify(h.db.prepare("SELECT text FROM source_parts").all())).not.toMatch(/zq-part/)
    } finally {
      h.close()
    }
  })

  test("the engine never ingests or recalls a forgotten session's content through a later fork (item 4)", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      const { projectId, workspace } = seed(db, { sessionId: "src" })
      const secret = "My recovery phrase starts with zq-engine-otter"
      ingest(db, "src", [userMsg(secret, { id: "m1", sessionID: "src" })])
      await env.engine.forgetSession("src", "user")
      const adapter = makeAdapter(new FakeRunner(), { directory: env.dir, project: { id: projectId, workspace, domain: "learning", name: "A", directory: env.dir } })
      track(env.engine, adapter, { id: "fork", title: "fork of src", fork: { sourceSessionID: "src", messages: { m1: "m1f" } } })
      env.engine.ingest("fork", [userMsg(secret, { id: "m1f", sessionID: "fork" })], { now: T0 })
      const recall = env.engine.recallSource({ projectId, workspace, sessionId: "fork" }, { sessionId: "fork", fromSeq: 1 })
      expect(recall.ok).toBe(true)
      const parts = recall.ok ? recall.messages.flatMap((m) => m.parts) : []
      expect(parts.length).toBeGreaterThan(0)
      expect(parts.every((p) => p.forgotten && !p.text.includes("zq-engine"))).toBe(true)
    } finally {
      await env.close()
    }
  })

  test("restore refusals are MemoryErrors: 400 for an unknown or missing file, 409 for a refused backup (item 5)", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      const dir = backupDir(env.config.dataDir)
      const empty = backupNow(db, env.config.dataDir, 5, T0)
      const { workspace, projectId, sessionId } = seed(db)
      const live = putObservation(db, { workspace, projectId, sessionId, content: "live memory that must survive" })
      const refusal = (fn: () => unknown) => {
        const e = caught(fn)
        return { name: e.name, status: e.status, leaks: e.message.includes(env.dir) || e.message.includes(dir) }
      }
      expect(refusal(() => env.engine.restore("memory-19990101-000000.db"))).toEqual({ name: "MemoryError", status: 400, leaks: false })
      expect(refusal(() => env.engine.restore("../memory.db"))).toEqual({ name: "MemoryError", status: 400, leaks: false })
      expect(refusal(() => env.engine.restore(basename(empty)))).toEqual({ name: "MemoryError", status: 409, leaks: false })

      const unmarked = "memory-20990101-000000.db"
      const fake = await openDb(join(dir, unmarked))
      seed(fake)
      putObservation(fake, { workspace, projectId, sessionId, content: "a database that was not made by backupNow" })
      fake.close()
      expect(refusal(() => env.engine.restore(unmarked))).toEqual({ name: "MemoryError", status: 409, leaks: false })

      const newer = "memory-20990102-000000.db"
      const future = await openDb(join(dir, newer))
      seed(future)
      putObservation(future, { workspace, projectId, sessionId, content: "a backup from a newer build" })
      future.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION + 1))
      future.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('backup_of', 'future')").run()
      future.close()
      const newerError = caught(() => env.engine.restore(newer))
      expect({ name: newerError.name, status: newerError.status }).toEqual({ name: "MemoryError", status: 409 })
      expect(newerError.message).toMatch(/not supported/)

      const garbage = "memory-20990103-000000.db"
      writeFileSync(join(dir, garbage), "this file is plain text and not a database at all\n".repeat(20))
      expect(refusal(() => env.engine.restore(garbage))).toEqual({ name: "MemoryError", status: 409, leaks: false })

      expect(refusal(() => restoreBackup(db, join(env.dir, "missing.db")))).toEqual({ name: "MemoryError", status: 400, leaks: false })
      expect(getObservation(db, live.id)?.status).toBe("active")
    } finally {
      await env.close()
    }
  })

  test("only runner sessions are internal: exact runner titles, runner agents and explicit marks (item 6)", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      const project = { id: "proj_a", workspace: "learn", domain: "learning", name: "A", directory: env.dir }
      upsertProject(db, project, T0)
      const adapter = makeAdapter(new FakeRunner(), { directory: env.dir, project })
      const msgs = (sid: string, agent?: string) => [userMsg("Let us sketch the design of the sync engine", { id: `${sid}_u1`, sessionID: sid, agent })]
      const captured = (sid: string, agent?: string) => env.engine.ingest(sid, msgs(sid, agent), { now: T0 })?.captured

      track(env.engine, adapter, { id: "ses_notes", title: "[memory] design notes" })
      expect(env.engine.isInternal("ses_notes")).toBe(false)
      expect(captured("ses_notes")).toBe(1)

      for (const [id, title] of [
        ["ses_obs", "[memory] observer"],
        ["ses_ref", "[memory] reflector"],
      ]) {
        track(env.engine, adapter, { id, title })
        expect(env.engine.isInternal(id)).toBe(true)
        expect(captured(id)).toBeUndefined()
      }

      track(env.engine, adapter, { id: "ses_worker", title: "Untitled" })
      expect(captured("ses_worker", "om-observer")).toBeUndefined()
      expect(env.engine.isInternal("ses_worker")).toBe(true)
      expect(db.prepare("SELECT internal_source FROM sessions WHERE id = ?").get<{ internal_source: string }>("ses_worker")?.internal_source).toBe("agent")

      track(env.engine, adapter, { id: "ses_build", title: "Build" })
      expect(captured("ses_build", "build")).toBe(1)

      track(env.engine, adapter, { id: "ses_marked", title: "anything" })
      env.engine.markInternal("ses_marked")
      expect(env.engine.isInternal("ses_marked")).toBe(true)
      expect(captured("ses_marked")).toBeUndefined()

      // Explicit provenance survives a process-local marker being absent on a later track.
      upsertSession(db, { id: "ses_persisted", projectId: "proj_a", title: "anything", internal: true, internalSource: "explicit" }, T0)
      track(env.engine, adapter, { id: "ses_persisted", title: "anything" })
      expect(env.engine.isInternal("ses_persisted")).toBe(true)
      expect(captured("ses_persisted")).toBeUndefined()

      // A row an older build marked internal for the "[memory]" prefix alone is released.
      upsertSession(db, { id: "ses_legacy", projectId: "proj_a", title: "[memory] roadmap", internal: true }, T0)
      expect(env.engine.isInternal("ses_legacy")).toBe(true)
      track(env.engine, adapter, { id: "ses_legacy", title: "[memory] roadmap" })
      expect(env.engine.isInternal("ses_legacy")).toBe(false)
      expect(db.prepare("SELECT internal_source FROM sessions WHERE id = ?").get<{ internal_source: string | null }>("ses_legacy")?.internal_source).toBeNull()
      expect(captured("ses_legacy")).toBe(1)
    } finally {
      await env.close()
    }
  })

  test("every change that can alter the memory block bumps the generation seen by another connection (item 7)", async () => {
    const env = await openEngine()
    const other = await openDatabase(join(env.dir, "memory.db"))
    try {
      const engine = env.engine
      const db = engine.db
      const { workspace, projectId, sessionId } = seed(db)
      const ctx = { projectId, workspace, sessionId }
      ingest(db, sessionId, [
        userMsg("First message about the parser", { id: "r1", sessionID: sessionId }),
        userMsg("Second message about the lexer", { id: "r2", sessionID: sessionId, at: T0 + 10 }),
      ])
      const put = (content: string, extra: Partial<Parameters<typeof putObservation>[1]> = {}) =>
        putObservation(db, { workspace, projectId, content, ...extra }).id
      const a = put("The parser is a Pratt parser")
      const b = put("The lexer is generated from a grammar file")
      const c = put("Error messages include the source span")
      const d = put("Benchmarks run nightly on the CI box")
      const e = put("The AST is immutable")
      const f = put("Parse errors recover at statement boundaries")
      const promo = put("The project follows semantic versioning")
      const pendingYes = put("The user prefers short commit messages", { scopeKind: "session", sessionId, status: "pending_review", targetScope: "project", actor: "user" })
      const pendingNo = put("The user prefers long commit messages", { scopeKind: "session", sessionId, status: "pending_review", targetScope: "project", actor: "user" })
      const quiz = put("The user confuses closures with callbacks", { scopeKind: "workspace", kind: "misconception", payload: { concept: "closures" } })
      const topic = () =>
        upsertTopic(db, {
          scopeKey: `project:${projectId}`,
          slug: "parser",
          title: "Parser",
          summary: `Parser notes ${Math.random()}`,
          sections: [{ heading: "Notes", bullets: [{ text: "Pratt parsing", refs: [a] }] }],
          actor: "reflector",
        })

      const before = memoryGeneration(other)
      put("A brand new fact about tokens")
      expect(memoryGeneration(other)).toBe(before)

      let topicId = ""
      const steps: [string, () => unknown][] = [
        ["forget", () => engine.forget([b], { actor: "user", reason: "forget" })],
        ["edit", () => engine.edit(c, "Error messages include the full source span")],
        ["supersede", () => engine.supersede(undefined, d, "Benchmarks run on every merge", "moved", "user")],
        ["approve", () => engine.approve(pendingYes)],
        ["reject", () => engine.reject(pendingNo)],
        ["revert", () => engine.onRevert(sessionId, "r2")],
        ["unrevert", () => engine.onUnrevert(sessionId, new Set(["r1", "r2"]))],
        ["pin", () => engine.pin(e, true)],
        ["unpin", () => engine.pin(e, false)],
        ["topic edit", () => (topicId = topic().id)],
        ["topic approve", () => engine.approveTopic(topicId)],
        ["topic rollback", () => engine.rollbackTopic(topicId, 1)],
        ["config save", () => engine.updateConfig(engine.config, { trusted: true })],
        ["pause", () => engine.setPaused(true)],
        ["resume", () => engine.setPaused(false)],
        ["session flag", () => engine.setSessionFlag(sessionId, "paused", true)],
        ["promotion", () => engine.approvePromotion(openReview(db, "promotion", promo, "shared", { scope: "workspace" }))],
        ["domain hooks", () => applyObservationDomainHooks(db, quiz)],
        ["forget session", () => engine.forgetSession("ses_other", "user")],
        ["suppression replay", () => applySuppressions(db)],
        ["restore", () => engine.restore(basename(backupNow(db, env.config.dataDir, 5, T0 + 60_000)))],
        [
          "expire",
          () => {
            db.prepare("UPDATE observations SET expires_at = 1 WHERE id = ?").run(f)
            engine.recover(T0)
          },
        ],
      ]
      seed(db, { sessionId: "ses_other" })
      for (const [name, run] of steps) {
        const prior = memoryGeneration(other)
        await run()
        expect({ name, bumped: memoryGeneration(other) > prior }).toEqual({ name, bumped: true })
      }
      expect(engine.memoryGeneration()).toBe(memoryGeneration(other))
      const block = buildMemoryBlock(other, { ctx, domain: "general", budget: env.config.inject.budget })
      expect(block.generation).toBe(memoryGeneration(other))
    } finally {
      other.close()
      await env.close()
    }
  })

  test("an unreviewed agent-written session row is visible only in its own session (item 8)", async () => {
    const env = await openEngine()
    try {
      const engine = env.engine
      const db = engine.db
      seed(db, { sessionId: "sA" })
      seed(db, { sessionId: "sB" })
      const A = { projectId: "proj_a", workspace: "learn", sessionId: "sA" }
      const B = { ...A, sessionId: "sB" }
      const P = { projectId: "proj_a", workspace: "learn" }
      const note = "zqagent the flaky upload test is caused by timezone drift"
      const r = engine.remember(A, { content: note, actor: "agent" })
      expect(r).toMatchObject({ ok: true, status: "active" })
      const id = r.ok ? r.id : ""
      expect(getObservation(db, id)).toMatchObject({ scope_kind: "session", actor: "agent", session_id: "sA" })
      const observed = putObservation(db, {
        workspace: "learn",
        projectId: "proj_a",
        scopeKind: "session",
        sessionId: "sA",
        content: "zqobserved the upload test retries three times",
        actor: "observer",
      })

      const block = (ctx: typeof A) =>
        buildMemoryBlock(db, { ctx, domain: "general", budget: env.config.inject.budget, query: "zqagent flaky upload timezone drift" }).block
      expect(block(A)).toContain("zqagent")
      expect(block(B)).not.toContain("zqagent")

      const ids = (hits: { row: { id: string } }[]) => hits.map((h) => h.row.id)
      expect(ids(engine.search(A, "zqagent timezone drift"))).toContain(id)
      expect(ids(engine.search(B, "zqagent timezone drift"))).not.toContain(id)
      expect(ids(engine.search(P, "zqagent timezone drift"))).not.toContain(id)
      expect(ids(engine.search(B, "zqagent timezone drift", { includeHistory: true }))).not.toContain(id)
      expect(ids(engine.search(B, "zqobserved upload retries"))).toContain(observed.id)
      expect(engine.list(A).map((o) => o.id)).toContain(id)
      expect(engine.list(B).map((o) => o.id)).not.toContain(id)
      expect(engine.observation(id, B)).toBeUndefined()
      expect(engine.recallSource(B, { observationId: id }).ok).toBe(false)
      expect(engine.forgetCandidates(note, A).map((c) => c.id)).toContain(id)
      expect(engine.forgetCandidates(note, B).map((c) => c.id)).not.toContain(id)
      const forgot = await engine.forget([id], { actor: "agent", reason: "agent forget", ctx: B })
      expect(forgot.skipped).toEqual([id])
      expect(getObservation(db, id)?.status).toBe("active")
    } finally {
      await env.close()
    }
  })

  test("rekeyInjection moves a pending block to the message id chat.params reports (item 9)", async () => {
    const env = await openEngine()
    try {
      const { workspace, projectId, sessionId } = seed(env.engine.db)
      putObservation(env.engine.db, { workspace, projectId, content: "The project uses pnpm workspaces" })
      const built = await env.engine.buildInjection(sessionId, undefined, "msg_1")
      expect(built?.block).toContain("pnpm")
      expect(env.engine.rekeyInjection(sessionId, "msg_other", "msg_2")).toBe(false)
      expect(env.engine.rekeyInjection(sessionId, "msg_1", "msg_2")).toBe(true)
      expect(env.engine.commitInjection(sessionId, "msg_1")).toBeUndefined()
      expect(env.engine.commitInjection(sessionId, "msg_2")).toBeTruthy()
      expect(env.engine.latestSnapshot(sessionId)?.request_key).toBe("msg_2")
      expect(env.engine.rekeyInjection(sessionId, "msg_2", "msg_3")).toBe(false)
    } finally {
      await env.close()
    }
  })

  test("a topic file that resolves outside the vault is never read, and the next write replaces the link (item 10)", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId } = seed(h.db)
      const row = putObservation(h.db, { workspace, projectId, content: "graphs have edges and vertices" })
      const vault = h.config.vaultDir
      const t = upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "graphs",
        title: "Graphs",
        summary: "Graph basics",
        sections: [{ heading: "Notes", bullets: [{ text: "graphs have edges", refs: [row.id] }] }],
        actor: "reflector",
      })
      expect(materializeOutbox(h.db, vault, "owner", T0).written).toBeGreaterThan(0)
      const rel = h.db.prepare("SELECT rel_path FROM topics WHERE id = ?").get<{ rel_path: string }>(t.id)!.rel_path
      const file = join(vault, rel)
      expect(existsSync(file)).toBe(true)
      const outside = join(h.dir, "outside.md")
      writeFileSync(outside, "# Stolen\n\n## Notes\n\n- zqoutside private text\n")
      unlinkSync(file)
      try {
        symlinkSync(outside, file, "file")
      } catch {
        return
      }
      expect(scanExternalEdits(h.db, vault, T0)).toBe(0)
      expect(resolveVaultConflict(h.db, t.id, vault, "keep-file", "user", T0)).toBe(true)
      expect(JSON.stringify(h.db.prepare("SELECT title, summary, body FROM topics").all())).not.toContain("zqoutside")
      materializeOutbox(h.db, vault, "owner", T0 + 1)
      expect(lstatSync(file).isSymbolicLink()).toBe(false)
      expect(readFileSync(file, "utf8")).not.toContain("zqoutside")
      expect(readFileSync(outside, "utf8")).toContain("zqoutside")
      expect(readdirSync(dirname(file)).filter((n) => n.includes("om-tmp"))).toEqual([])
    } finally {
      h.close()
    }
  })
})
