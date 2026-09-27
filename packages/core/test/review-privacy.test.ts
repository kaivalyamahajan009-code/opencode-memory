import { afterAll, describe, expect, test } from "bun:test"
import { basename, dirname, join } from "node:path"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import {
  CUT,
  FakeRunner,
  T0,
  cleanupAllTempDirs,
  defaultConfig,
  ingest,
  openDb,
  openEngine,
  openHarness,
  putObservation,
  seed,
  silent,
  tempDir,
  userMsg,
  assistantMsg,
} from "./helpers"
import { applySuppressions, forgetObservations, forgetSession, findForgetCandidates, inForgetScope } from "../src/forget"
import { applyReflectorOps, reflectScope } from "../src/reflector"
import {
  backupDir,
  backupNow,
  backupWatermark,
  exportJson,
  listBackups,
  restoreBackup,
  scrubBackups,
  scrubPending,
  walTruncatePending,
} from "../src/backup"
import { captureToolArtifacts, isUncPath, resolveArtifactPath } from "../src/artifacts"
import { backfillEmbeddings, storeEmbedding, type Embedder } from "../src/embeddings"
import { recordForkLineage } from "../src/lifecycle"
import { MemoryEngine } from "../src/engine"
import { suppressionGeneration } from "../src/observations"
import type { Database } from "../src/sqlite"
import {
  enqueueVaultDelete,
  materializeOutbox,
  parseTopicBody,
  regenerateIndexes,
  resolveVaultConflict,
  scanExternalEdits,
  scopeDir,
  upsertTopic,
} from "../src/vault"
import { editObservation, getObservation, isSuppressed } from "../src/observations"
import { upsertArtifact } from "../src/artifacts"
import { openDatabase } from "../src/sqlite"
import { assertLease, claimChunk, cutChunks, StaleLeaseError } from "../src/chunks"
import { upsertProject } from "../src/ingest"
import { contentHash } from "../src/util"

afterAll(cleanupAllTempDirs)

const SECRET = `ghp_${"a".repeat(36)}`

describe("review privacy fixes", () => {
  test("forget during a running reflector drops ops that cite the forgotten row", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const live = putObservation(h.db, { workspace, projectId, sessionId, content: "live durable note about graphs" })
      const gone = putObservation(h.db, { workspace, projectId, sessionId, content: "secret home address 12 Main St" })
      const runner = new FakeRunner()
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      runner.enqueue(async () => {
        await gate
        return {
          ops: [
            {
              op: "upsert_topic",
              slug: "graphs",
              title: "Graphs",
              sections: [
                {
                  heading: "Notes",
                  bullets: [
                    { text: "secret home address 12 Main St", refs: ["o2"] },
                    { text: "mixes live and forgotten", refs: ["o1", "o2"] },
                    { text: "graphs have edges", refs: ["o1"] },
                  ],
                },
              ],
            },
            { op: "append_journey", entry: "Learned the secret address", refs: ["o2"] },
          ],
        }
      })
      const pending = reflectScope({ db: h.db, config: h.config, runner, owner: "test-owner" }, `project:${projectId}`)
      forgetObservations(h.db, [gone.id], { actor: "user", reason: "forget address", purgeSources: "none" })
      release()
      const outcome = await pending
      expect(["applied", "failed", "empty", "busy"]).toContain(outcome.status)
      const topics = h.db.prepare("SELECT body FROM topics").all<{ body: string }>()
      for (const t of topics) {
        expect(t.body).not.toContain(gone.id)
        expect(t.body).not.toContain("12 Main St")
      }
      const journey = h.db.prepare("SELECT entry, refs FROM journey_entries").all<{ entry: string; refs: string }>()
      for (const j of journey) {
        expect(j.entry).not.toContain("secret address")
        expect(j.refs).not.toContain(gone.id)
      }
      expect(getObservation(h.db, live.id)?.status).not.toBe("forgotten")
    } finally {
      h.close()
    }
  })

  test("journey-only forget rewrites JOURNEY.md", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content: "journey-only secret about a childhood nickname" })
      h.db
        .prepare("INSERT INTO journey_entries(id, scope_key, at, entry, refs) VALUES (?,?,?,?,?)")
        .run("jr_only", `workspace:${workspace}`, T0, `Reached a milestone citing ${id}`, JSON.stringify([id]))
      regenerateIndexes(h.db, workspace, T0)
      forgetObservations(h.db, [id], { actor: "user", reason: "forget", purgeSources: "none" })
      const row = h.db
        .prepare("SELECT content FROM vault_outbox WHERE rel_path LIKE '%JOURNEY.md' ORDER BY id DESC LIMIT 1")
        .get<{ content: string }>()
      expect(row?.content).toBeTruthy()
      expect(row!.content).not.toContain(id)
      expect(row!.content).not.toContain("childhood nickname")
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM journey_entries").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("restore after edit-then-forget stays forgotten", async () => {
    const h = await openHarness({ file: true })
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const original = "A unique forgettable fact about a childhood pet named Marmalade"
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content: original })
      const file = backupNow(h.db, h.dir, 3, T0)
      expect(editObservation(h.db, id, "Edited unique forgettable fact about Marmalade the cat")).toBe(true)
      forgetObservations(h.db, [id], { actor: "user", reason: "forget that my address is 12 Main St", purgeSources: "none" })
      const reasons = h.db.prepare("SELECT reason FROM suppressions").all<{ reason: string | null }>()
      expect(reasons.every((r) => r.reason && !r.reason.includes("12 Main St") && !r.reason.includes("address"))).toBe(true)
      restoreBackup(h.db, file)
      const row = getObservation(h.db, id)!
      expect(row.status).toBe("forgotten")
      expect(row.content).toBe("[forgotten]")
      expect(isSuppressed(h.db, original)).toBe(true)
    } finally {
      h.close()
    }
  })

  test("restore after forgetSession keeps the session excluded and artifacts gone", async () => {
    const h = await openHarness({ file: true })
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        content: "session-only note about a private phone number",
        sources: [{ sessionId, startMessageId: "u1", endMessageId: "u1", startSeq: 1, endSeq: 1, transformVersion: 1 }],
      })
      upsertArtifact(h.db, {
        workspace,
        projectId,
        sessionId,
        messageId: "u1",
        path: "/tmp/diagram.svg",
        kind: "svg",
        origin: "test",
        content: "<svg><title>secret diagram</title></svg>",
      })
      const file = backupNow(h.db, h.dir, 3, T0)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get<{ n: number }>()!.n).toBe(1)
      forgetSession(h.db, sessionId, "user")
      expect(h.db.prepare("SELECT excluded, title FROM sessions WHERE id = ?").get<{ excluded: number; title: string | null }>(sessionId)).toMatchObject({
        excluded: 1,
        title: null,
      })
      restoreBackup(h.db, file)
      expect(h.db.prepare("SELECT excluded, title FROM sessions WHERE id = ?").get<{ excluded: number; title: string | null }>(sessionId)).toMatchObject({
        excluded: 1,
        title: null,
      })
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get<{ n: number }>()!.n).toBe(0)
      const live = h.db.prepare("SELECT content FROM observations WHERE status != 'forgotten'").all<{ content: string }>()
      expect(live.every((r) => !r.content.includes("phone number"))).toBe(true)
    } finally {
      h.close()
    }
  })

  test("keep-file over forgotten refs drops them and redacts secrets", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const gone = putObservation(h.db, { workspace, projectId, sessionId, content: "private wallet seed phrase about zebras" })
      const live = putObservation(h.db, { workspace, projectId, sessionId, content: "public note about hash maps" })
      const topic = upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "notes",
        title: "Notes",
        summary: `mentions ${gone.id}`,
        sections: [{ heading: "One", bullets: [{ text: "private wallet seed phrase about zebras", refs: [gone.id] }] }],
        actor: "test",
      })
      mkdirSync(h.config.vaultDir, { recursive: true })
      expect(materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0).written).toBeGreaterThanOrEqual(1)
      forgetObservations(h.db, [gone.id], { actor: "user", reason: "forget", purgeSources: "none" })
      materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0 + 10)
      const rel = h.db.prepare("SELECT rel_path FROM topics WHERE id = ?").get<{ rel_path: string }>(topic.id)!.rel_path
      const path = join(h.config.vaultDir, rel)
      writeFileSync(
        path,
        [
          "---",
          `om_id: "${topic.id}"`,
          "om_generation: 1",
          'om_hash: "stale"',
          "---",
          "# Notes",
          "",
          `> summary cites ${gone.id}`,
          "",
          "## One",
          "",
          `User kept paragraph with ${SECRET}`,
          `- leaked bullet — refs: ${gone.id}`,
          `- still live — refs: ${live.id}`,
          `- my own note without refs`,
          "",
        ].join("\n"),
      )
      expect(scanExternalEdits(h.db, h.config.vaultDir, T0 + 20)).toBeGreaterThanOrEqual(1)
      expect(resolveVaultConflict(h.db, topic.id, h.config.vaultDir, "keep-file", "user", T0 + 30)).toBe(true)
      const row = h.db.prepare("SELECT body, approved, summary FROM topics WHERE id = ?").get<{ body: string; approved: number; summary: string }>(topic.id)!
      expect(row.approved).toBe(0)
      expect(row.body).not.toContain(gone.id)
      expect(row.body).not.toContain("leaked bullet")
      expect(row.body).not.toContain(SECRET)
      expect(row.body).toContain("[REDACTED:github-token]")
      expect(row.body).toContain("my own note without refs")
      expect(row.body).toContain(live.id)
      expect(row.summary ?? "").not.toContain(gone.id)
      const gen = h.db.prepare("SELECT actor FROM topic_generations WHERE topic_id = ? ORDER BY generation DESC LIMIT 1").get<{ actor: string }>(topic.id)
      expect(gen?.actor).toBe("external-edit")
    } finally {
      h.close()
    }
  })

  test("outbox history is scrubbed on forget regardless of state", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const { id } = putObservation(h.db, { scopeKind: "workspace", workspace, projectId, sessionId, content: "outbox secret about a hidden cabin" })
      const topic = upsertTopic(h.db, {
        scopeKey: `workspace:${workspace}`,
        slug: "cabin",
        title: "Cabin",
        summary: "",
        sections: [{ heading: "One", bullets: [{ text: "hidden cabin", refs: [id] }] }],
        actor: "test",
      })
      mkdirSync(h.config.vaultDir, { recursive: true })
      materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0)
      const written = h.db
        .prepare("SELECT id, content, state FROM vault_outbox WHERE topic_id = ? AND state = 'written'")
        .all<{ id: number; content: string; state: string }>(topic.id)
      expect(written.length).toBeGreaterThanOrEqual(1)
      expect(written.some((w) => w.content.includes(id))).toBe(true)
      forgetObservations(h.db, [id], { actor: "user", reason: "forget", purgeSources: "none" })
      const after = h.db.prepare("SELECT content FROM vault_outbox").all<{ content: string }>()
      for (const row of after) {
        if (row.content) expect(row.content).not.toContain(id)
      }
      const oldWritten = h.db.prepare("SELECT content FROM vault_outbox WHERE id = ?").get<{ content: string }>(written[0].id)
      expect(oldWritten?.content ?? "").toBe("")
    } finally {
      h.close()
    }
  })

  test("embeddings backfill does not store a vector forgotten during embed", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const content = "embeddable secret about a locker combination 4242"
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content })
      const hash = contentHash(content)
      const embedder: Embedder = {
        model: "test-model",
        async embed() {
          forgetObservations(h.db, [id], { actor: "user", reason: "forget", purgeSources: "none" })
          return [new Float32Array([0.1, 0.2, 0.3])]
        },
      }
      const done = await backfillEmbeddings(h.db, embedder, { batchSize: 8, max: 16 })
      expect(done).toBeGreaterThanOrEqual(1)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE content_hash = ?").get<{ n: number }>(hash)!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("condensed-evidence topic bullets survive the next merge with rewritten refs", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const a = putObservation(h.db, { id: "obs_src_a", workspace, projectId, sessionId, content: "first evidence about B-trees", now: T0 })
      const b = putObservation(h.db, { id: "obs_src_b", workspace, projectId, sessionId, content: "second evidence about B-trees", now: T0 + 1 })
      const extra = putObservation(h.db, { id: "obs_live_c", workspace, projectId, sessionId, content: "hash maps are separate", now: T0 + 2 })
      const topic = upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "trees",
        title: "Trees",
        summary: "overview",
        sections: [{ heading: "B-trees", bullets: [{ text: "B-trees from first evidence", refs: [a.id] }] }],
        actor: "test",
      })
      const refs = new Map([
        ["o1", getObservation(h.db, a.id)!],
        ["o2", getObservation(h.db, b.id)!],
      ])
      applyReflectorOps(
        h.db,
        `project:${projectId}`,
        refs,
        [{ op: "condense", refs: ["o1", "o2"], content: "Combined B-tree evidence", kind: "fact" }],
        [a.id, b.id],
        T0 + 10,
      )
      expect(getObservation(h.db, a.id)?.status).toBe("superseded")
      const condensedId = h.db.prepare("SELECT id FROM observations WHERE kind = 'condensed'").get<{ id: string }>()!.id
      upsertTopic(
        h.db,
        {
          scopeKey: `project:${projectId}`,
          slug: "trees",
          title: "Trees",
          summary: "",
          sections: [{ heading: "Maps", bullets: [{ text: "Hash maps are separate", refs: [extra.id] }] }],
          actor: "reflector",
          merge: true,
        },
        T0 + 20,
      )
      const body = h.db.prepare("SELECT body FROM topics WHERE id = ?").get<{ body: string }>(topic.id)!.body
      const parsed = parseTopicBody(body)
      const btree = parsed.sections.find((s) => s.heading === "B-trees")
      expect(btree).toBeTruthy()
      expect(btree!.bullets.some((x) => x.text.includes("B-trees from first evidence"))).toBe(true)
      expect(btree!.bullets.every((x) => !x.refs.includes(a.id))).toBe(true)
      expect(btree!.bullets.some((x) => x.refs.includes(condensedId))).toBe(true)
    } finally {
      h.close()
    }
  })

  test("project vault dirs are unique for the same name", async () => {
    const h = await openHarness()
    try {
      upsertProject(h.db, { id: "proj_front_a", workspace: "ws", domain: "general", name: "frontend", directory: "/tmp/a" }, T0)
      upsertProject(h.db, { id: "proj_front_b", workspace: "ws", domain: "general", name: "frontend", directory: "/tmp/b" }, T0)
      const da = scopeDir(h.db, "project:proj_front_a")
      const dbPath = scopeDir(h.db, "project:proj_front_b")
      expect(da).not.toBe(dbPath)
      expect(da.toLowerCase()).toContain("frontend")
      expect(dbPath.toLowerCase()).toContain("frontend")
    } finally {
      h.close()
    }
  })

  test("workspace export filters topics and journey", async () => {
    const h = await openHarness()
    try {
      const a = seed(h.db, { workspace: "learn", projectId: "proj_a", sessionId: "ses_a" })
      const b = seed(h.db, { workspace: "other", projectId: "proj_b", sessionId: "ses_b" })
      const oa = putObservation(h.db, { workspace: a.workspace, projectId: a.projectId, sessionId: a.sessionId, content: "learn topic evidence" })
      const ob = putObservation(h.db, { workspace: b.workspace, projectId: b.projectId, sessionId: b.sessionId, content: "other topic evidence" })
      upsertTopic(h.db, {
        scopeKey: `workspace:${a.workspace}`,
        slug: "learn-notes",
        title: "Learn notes",
        summary: "",
        sections: [{ heading: "One", bullets: [{ text: "learn topic evidence", refs: [oa.id] }] }],
        actor: "test",
      })
      upsertTopic(h.db, {
        scopeKey: `workspace:${b.workspace}`,
        slug: "other-notes",
        title: "Other notes",
        summary: "",
        sections: [{ heading: "One", bullets: [{ text: "other topic evidence", refs: [ob.id] }] }],
        actor: "test",
      })
      h.db
        .prepare("INSERT INTO journey_entries(id, scope_key, at, entry, refs) VALUES (?,?,?,?,?)")
        .run("jr_a", `workspace:${a.workspace}`, T0, "learn milestone", JSON.stringify([oa.id]))
      h.db
        .prepare("INSERT INTO journey_entries(id, scope_key, at, entry, refs) VALUES (?,?,?,?,?)")
        .run("jr_b", `workspace:${b.workspace}`, T0, "other milestone", JSON.stringify([ob.id]))
      const exported = exportJson(h.db, { workspace: "learn" })
      expect(exported.topics.every((t: { scope_key: string }) => t.scope_key === "workspace:learn" || t.scope_key === "project:proj_a")).toBe(true)
      expect(exported.topics.some((t: { title: string }) => t.title === "Other notes")).toBe(false)
      expect(exported.journey.every((j: { scope_key: string }) => j.scope_key === "workspace:learn" || j.scope_key === "project:proj_a")).toBe(true)
      expect(exported.journey.some((j: { entry: string }) => j.entry.includes("other milestone"))).toBe(false)
    } finally {
      h.close()
    }
  })

  test("forget cancels a running overlapping chunk so the lease assertion fails", async () => {
    const h = await openHarness()
    try {
      const { sessionId, projectId, workspace } = seed(h.db)
      ingest(h.db, sessionId, [userMsg("alpha beta gamma delta", { id: "u1" }), assistantMsg("epsilon zeta eta", { id: "a1", at: T0 + 1 })])
      const ids = cutChunks(h.db, sessionId, "explicit", { ...CUT, maxChunkTokens: 10_000, now: T0 })
      expect(ids.length).toBeGreaterThanOrEqual(1)
      const claim = claimChunk(h.db, "owner-a", { leaseMs: 60_000, now: T0 })!
      const part = h.db.prepare("SELECT id FROM source_parts WHERE message_id = 'u1'").get<{ id: string }>()!
      const { id } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        content: "observation drawn from the running chunk",
        sources: [{ sessionId, startMessageId: "u1", endMessageId: "u1", startSeq: 1, endSeq: 1, partIds: [part.id], transformVersion: 1 }],
      })
      forgetObservations(h.db, [id], { actor: "user", reason: "forget", purgeSources: "sources" })
      expect(() => assertLease(h.db, claim)).toThrow(StaleLeaseError)
      expect(h.db.prepare("SELECT state FROM chunks WHERE id = ?").get<{ state: string }>(claim.chunk.id)?.state).toBe("cancelled")
    } finally {
      h.close()
    }
  })

  test("engine.forget with ctx skips ids outside scope and includes superseded candidates", async () => {
    const env = await openEngine()
    try {
      const a = seed(env.engine.db, { workspace: "learn", projectId: "proj_a", sessionId: "ses_a" })
      const b = seed(env.engine.db, { workspace: "other", projectId: "proj_b", sessionId: "ses_b" })
      const mine = putObservation(env.engine.db, { workspace: a.workspace, projectId: a.projectId, sessionId: a.sessionId, content: "in-scope fact about widgets" })
      const other = putObservation(env.engine.db, {
        workspace: b.workspace,
        projectId: b.projectId,
        sessionId: b.sessionId,
        content: "out-of-scope fact about widgets",
      })
      env.engine.db.prepare("UPDATE observations SET status = 'superseded' WHERE id = ?").run(mine.id)
      const cand = env.engine.forgetCandidates("widgets", { projectId: a.projectId, workspace: a.workspace, sessionId: a.sessionId })
      expect(cand.some((c) => c.id === mine.id)).toBe(true)
      expect(cand.some((c) => c.id === other.id)).toBe(false)
      const r = await env.engine.forget([mine.id, other.id], {
        actor: "agent",
        reason: "agent forget",
        ctx: { projectId: a.projectId, workspace: a.workspace, sessionId: a.sessionId },
      })
      expect(r.skipped).toContain(other.id)
      expect(getObservation(env.engine.db, mine.id)?.status).toBe("forgotten")
      expect(getObservation(env.engine.db, other.id)?.status).not.toBe("forgotten")
    } finally {
      await env.close()
    }
  })

  test("paid reflection that fails to commit still records the model cost", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      putObservation(h.db, { workspace, projectId, sessionId, content: "durable fact used only to trigger reflection" })
      const runner = new FakeRunner()
      runner.enqueue(async () => {
        h.db.prepare("UPDATE jobs SET version = version + 1 WHERE key LIKE 'reflect:%'").run()
        return {
          ops: [
            {
              op: "upsert_topic",
              slug: "x",
              title: "X",
              sections: [{ heading: "H", bullets: [{ text: "durable fact used only to trigger reflection", refs: ["o1"] }] }],
            },
          ],
        }
      })
      const outcome = await reflectScope({ db: h.db, config: h.config, runner, owner: "cost-owner" }, `project:${projectId}`)
      expect(outcome.status).toBe("failed")
      const op = h.db.prepare("SELECT cost, status FROM operations ORDER BY started_at DESC LIMIT 1").get<{ cost: number; status: string }>()
      expect(op?.status).toBe("failed")
      expect(op?.cost).toBe(0.001)
    } finally {
      h.close()
    }
  })

  test("keep-file user paragraphs survive the next topic merge", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const live = putObservation(h.db, { workspace, projectId, sessionId, content: "generated evidence about queues" })
      const topic = upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "queues",
        title: "Queues",
        summary: "",
        sections: [{ heading: "Notes", bullets: [{ text: "generated evidence about queues", refs: [live.id] }] }],
        actor: "test",
      })
      mkdirSync(h.config.vaultDir, { recursive: true })
      materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0)
      const rel = h.db.prepare("SELECT rel_path FROM topics WHERE id = ?").get<{ rel_path: string }>(topic.id)!.rel_path
      const path = join(h.config.vaultDir, rel)
      const disk = readFileSync(path, "utf8")
      writeFileSync(path, `${disk}A hand-written paragraph.\n- my ref-less bullet\n`)
      scanExternalEdits(h.db, h.config.vaultDir, T0 + 5)
      resolveVaultConflict(h.db, topic.id, h.config.vaultDir, "keep-file", "user", T0 + 6)
      upsertTopic(
        h.db,
        {
          scopeKey: `project:${projectId}`,
          slug: "queues",
          title: "Queues",
          summary: "",
          sections: [{ heading: "Notes", bullets: [{ text: "updated generated evidence about queues", refs: [live.id] }] }],
          actor: "reflector",
          merge: true,
        },
        T0 + 10,
      )
      const body = h.db.prepare("SELECT body FROM topics WHERE id = ?").get<{ body: string }>(topic.id)!.body
      expect(body).toContain("my ref-less bullet")
      expect(body).toContain("hand-written paragraph")
    } finally {
      h.close()
    }
  })

  test("same-hash copies and predecessors are forgotten together", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const older = putObservation(h.db, { workspace, projectId, sessionId, content: "duplicated secret about a locker in building B", now: T0 })
      const newer = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        content: "replacement secret about a locker in building B",
        now: T0 + 10,
      })
      h.db.prepare("UPDATE observations SET status = 'superseded', superseded_by = ? WHERE id = ?").run(newer.id, older.id)
      h.db.prepare("UPDATE observations SET supersedes_id = ? WHERE id = ?").run(older.id, newer.id)
      seed(h.db, { sessionId: "ses_copy", projectId: "proj_copy", workspace })
      const copy = putObservation(h.db, {
        workspace,
        projectId: "proj_copy",
        sessionId: "ses_copy",
        content: "replacement secret about a locker in building B",
        now: T0 + 20,
      })
      forgetObservations(h.db, [newer.id], { actor: "user", reason: "forget", purgeSources: "none" })
      expect(getObservation(h.db, older.id)?.status).toBe("forgotten")
      expect(getObservation(h.db, newer.id)?.status).toBe("forgotten")
      expect(getObservation(h.db, copy.id)?.status).toBe("forgotten")
      const cand = findForgetCandidates(h.db, "locker in building")
      expect(cand.every((c) => c.id !== older.id)).toBe(true)
    } finally {
      h.close()
    }
  })

  test("scoped forget leaves an identical copy in another workspace alone, also after replay, scrub and restore", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      seed(db, { workspace: "w1", projectId: "p1", sessionId: "s1" })
      seed(db, { workspace: "w2", projectId: "p2", sessionId: "s2" })
      const text = "Deploys go out every Friday afternoon"
      const mine = putObservation(db, { workspace: "w1", projectId: "p1", sessionId: "s1", content: text })
      const theirs = putObservation(db, { workspace: "w2", projectId: "p2", sessionId: "s2", content: text })
      const file = backupNow(db, env.config.dataDir, 3, T0)
      const ctx = { projectId: "p1", workspace: "w1", sessionId: "s1" }
      const r = await env.engine.forget([mine.id], { actor: "agent", reason: "agent forget", ctx, awaitScrub: true })
      expect(r.observationIds).toEqual([mine.id])
      expect(r.backupsScrubbed).toBe(1)
      expect(getObservation(db, theirs.id)).toMatchObject({ status: "active", content: text })
      expect(isSuppressed(db, text, { scope_kind: "project", project_id: "p1", workspace: "w1" })).toBe(true)
      expect(isSuppressed(db, text, { scope_kind: "project", project_id: "p2", workspace: "w2" })).toBe(false)
      applySuppressions(db)
      expect(getObservation(db, theirs.id)?.status).toBe("active")
      const bak = await openDatabase(file, { create: false })
      try {
        expect(getObservation(bak, mine.id)?.status).toBe("forgotten")
        expect(getObservation(bak, theirs.id)?.status).toBe("active")
      } finally {
        bak.close()
      }
      env.engine.restore(file.split(/[\\/]/).pop()!)
      expect(getObservation(db, mine.id)?.status).toBe("forgotten")
      expect(getObservation(db, theirs.id)).toMatchObject({ status: "active", content: text })
      const denied = await env.engine.forget([theirs.id], { actor: "agent", reason: "agent forget", ctx })
      expect(denied.observationIds).toEqual([])
      expect(denied.skipped).toEqual([theirs.id])
    } finally {
      await env.close()
    }
  })

  test("forget candidates never include another session's pending_review rows, even past the limit", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { workspace: "w", projectId: "p", sessionId: "s1" })
      seed(h.db, { workspace: "w", projectId: "p", sessionId: "s2" })
      for (const [i, word] of ["alpha", "bravo", "charlie", "delta", "echo"].entries())
        putObservation(h.db, {
          workspace: "w",
          projectId: "p",
          sessionId: "s2",
          scopeKind: "session",
          status: "pending_review",
          content: `pending widget launch secret ${word}`,
          now: T0 + 100 + i,
        })
      const mine = putObservation(h.db, { workspace: "w", projectId: "p", sessionId: "s1", scopeKind: "session", status: "pending_review", content: "my own widget launch note", now: T0 })
      const ctx = { projectId: "p", workspace: "w", sessionId: "s1" }
      expect(findForgetCandidates(h.db, "widget launch", 1, ctx).map((c) => c.id)).toEqual([mine.id])
      const other = h.db.prepare("SELECT * FROM observations WHERE session_id = 's2' LIMIT 1").get<any>()
      expect(inForgetScope(ctx, other)).toBe(false)
    } finally {
      h.close()
    }
  })

  test("restore refuses a file without the backup marker or without core rows", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      const empty = backupNow(db, env.config.dataDir, 5, T0)
      const { workspace, projectId, sessionId } = seed(db)
      const live = putObservation(db, { workspace, projectId, sessionId, content: "live memory that must survive" })
      expect(() => env.engine.restore(empty.split(/[\\/]/).pop()!)).toThrow(/no sessions/)
      const fakeName = "memory-20990101-000000.db"
      const fake = await openDb(join(backupDir(env.config.dataDir), fakeName))
      seed(fake)
      putObservation(fake, { workspace, projectId, sessionId, content: "a database that was not made by backupNow" })
      fake.close()
      expect(listBackups(env.config.dataDir).some((b) => b.file === fakeName)).toBe(true)
      expect(() => env.engine.restore(fakeName)).toThrow(/marker/)
      expect(getObservation(db, live.id)?.status).toBe("active")
    } finally {
      await env.close()
    }
  })

  test("engine forget scrubs in the background, persists a failed backup and retries it on tick", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      const { workspace, projectId, sessionId } = seed(db)
      const a = putObservation(db, { workspace, projectId, sessionId, content: "background scrub secret about a red bicycle" })
      const b = putObservation(db, { workspace, projectId, sessionId, content: "awaited scrub secret about a blue canoe" })
      backupNow(db, env.config.dataDir, 5, T0)
      const badName = "memory-20000101-000000.db"
      const bad = join(backupDir(env.config.dataDir), badName)
      writeFileSync(bad, "not a database ".repeat(100))
      const bg = await env.engine.forget([a.id], { actor: "user", reason: "forget" })
      expect(bg.scrubPending).toBe(true)
      expect(bg.backupsScrubbed).toBeUndefined()
      expect(scrubPending(db)).toBeTruthy()
      const awaited = await env.engine.forget([b.id], { actor: "user", reason: "forget", awaitScrub: true })
      expect(awaited).toMatchObject({ backupsScrubbed: 1, backupsFailed: 1, scrubPending: true })
      expect(scrubPending(db)?.files).toEqual([badName])
      unlinkSync(bad)
      await env.engine.tick(Date.now() + 3 * 3_600_000)
      for (let i = 0; i < 100 && scrubPending(db); i++) await Bun.sleep(20)
      expect(scrubPending(db)).toBeUndefined()
    } finally {
      await env.close()
    }
  })

  test("a scrub left pending is resumed when the engine opens", async () => {
    const dir = tempDir()
    const dbPath = join(dir, "memory.db")
    const db = await openDb(dbPath)
    db.prepare("INSERT OR REPLACE INTO runtime_state(key, value, until, updated_at) VALUES ('scrub_pending', ?, 0, ?)").run(
      JSON.stringify({ files: null, attempts: 1, token: "crashed" }),
      T0,
    )
    db.close()
    const env = await openEngine({ dbPath })
    try {
      for (let i = 0; i < 100 && scrubPending(env.engine.db); i++) await Bun.sleep(20)
      expect(scrubPending(env.engine.db)).toBeUndefined()
    } finally {
      await env.close()
    }
  })

  test("topic refs must be readable from the topic's scope (upsert and keep-file)", async () => {
    const h = await openHarness()
    try {
      const a = seed(h.db, { workspace: "w1", projectId: "p1", sessionId: "s1" })
      const b = seed(h.db, { workspace: "w2", projectId: "p2", sessionId: "s2" })
      const mine = putObservation(h.db, { workspace: a.workspace, projectId: a.projectId, sessionId: a.sessionId, content: "local note about builds" })
      const foreign = putObservation(h.db, { workspace: b.workspace, projectId: b.projectId, sessionId: b.sessionId, content: "other workspace payroll detail" })
      const topic = upsertTopic(h.db, {
        scopeKey: `project:${a.projectId}`,
        slug: "builds",
        title: "Builds",
        summary: "",
        sections: [{ heading: "Notes", bullets: [{ text: "local builds", refs: [mine.id] }, { text: "foreign payroll", refs: [foreign.id] }] }],
        actor: "test",
      })
      const body = () => h.db.prepare("SELECT body FROM topics WHERE id = ?").get<{ body: string }>(topic.id)!.body
      expect(body()).toContain(mine.id)
      expect(body()).not.toContain(foreign.id)
      mkdirSync(h.config.vaultDir, { recursive: true })
      materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0)
      const path = join(h.config.vaultDir, h.db.prepare("SELECT rel_path FROM topics WHERE id = ?").get<{ rel_path: string }>(topic.id)!.rel_path)
      writeFileSync(path, `${readFileSync(path, "utf8")}- pasted foreign bullet — refs: ${foreign.id}\n`)
      scanExternalEdits(h.db, h.config.vaultDir, T0 + 5)
      expect(resolveVaultConflict(h.db, topic.id, h.config.vaultDir, "keep-file", "user", T0 + 6)).toBe(true)
      expect(body()).not.toContain(foreign.id)
      expect(body()).not.toContain("pasted foreign bullet")
      expect(body()).toContain(mine.id)
    } finally {
      h.close()
    }
  })

  test("tool artifacts must resolve inside the project directory; UNC paths are rejected", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const root = tempDir()
      const proj = join(root, "proj")
      mkdirSync(proj, { recursive: true })
      writeFileSync(join(proj, "inside.svg"), "<svg><title>inside</title></svg>")
      writeFileSync(join(root, "outside.svg"), "<svg><title>outside</title></svg>")
      const cap = (filePath: string, directory = proj) =>
        captureToolArtifacts(h.db, { tool: "write", args: { filePath }, directory, workspace, projectId, sessionId })
      expect(cap("inside.svg").length).toBe(1)
      expect(cap("../outside.svg")).toEqual([])
      expect(cap(join(root, "outside.svg"))).toEqual([])
      expect(cap("\\\\evil-server\\share\\x.svg")).toEqual([])
      expect(cap("//evil-server/share/x.svg")).toEqual([])
      expect(cap("x.svg", "\\\\evil-server\\share\\proj")).toEqual([])
      expect(isUncPath("\\\\server\\share")).toBe(true)
      expect(isUncPath("//server/share")).toBe(true)
      expect(isUncPath("C:\\Users\\me")).toBe(false)
      if (process.platform === "win32") expect(resolveArtifactPath(proj.toUpperCase(), "inside.svg")).toBeTruthy()
      let linked = false
      try {
        symlinkSync(join(root, "outside.svg"), join(proj, "link.svg"))
        linked = true
      } catch {}
      if (linked) expect(cap("link.svg")).toEqual([])
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get<{ n: number }>()!.n).toBe(1)
    } finally {
      h.close()
    }
  })
})

describe("privacy review: replay scope, durable scrub, WAL, vault outbox, forks", () => {
  const scopeOf = (db: Database, kind: string, value: string) => {
    const row = db.prepare("SELECT scope FROM suppressions WHERE kind = ? AND value = ?").get<{ scope: string | null }>(kind, value)
    return row ? (row.scope ? JSON.parse(row.scope) : null) : undefined
  }
  const queueWrite = (db: Database, rel: string, content: string) =>
    db
      .prepare("INSERT INTO vault_outbox(rel_path, topic_id, generation, content, hash, state, created_at) VALUES (?, NULL, NULL, ?, 'h', 'pending', ?)")
      .run(rel, content, T0)

  test("an agent forget of shared rows from another project: scrub and restore never widen its scope", async () => {
    const h = await openHarness({ file: true })
    try {
      seed(h.db, { workspace: "w1", projectId: "pA", sessionId: "sA" })
      seed(h.db, { workspace: "w1", projectId: "pB", sessionId: "sB" })
      seed(h.db, { workspace: "w2", projectId: "pC", sessionId: "sC" })
      const shared = "The orchard gate code is kept in the blue tin by the shed"
      const personal = "The locker at the gym is number four hundred and twelve"
      const wsRow = putObservation(h.db, { workspace: "w1", projectId: "pB", scopeKind: "workspace", content: shared })
      const pbCopy = putObservation(h.db, { workspace: "w1", projectId: "pB", sessionId: "sB", scopeKind: "project", content: shared })
      const userRow = putObservation(h.db, { workspace: "w2", projectId: "pC", scopeKind: "user", content: personal })
      const w2Copy = putObservation(h.db, { workspace: "w2", projectId: "pC", scopeKind: "workspace", content: personal })
      const file = backupNow(h.db, h.dir, 10, T0)
      const r = forgetObservations(h.db, [wsRow.id, userRow.id], { actor: "agent", reason: "agent forget", ctx: { projectId: "pA", workspace: "w1" } })
      expect(r.observationIds.sort()).toEqual([wsRow.id, userRow.id].sort())
      const boundary = [{ w: "w1", p: "pA" }]
      const check = (db: Database) => {
        expect(getObservation(db, wsRow.id)?.status).toBe("forgotten")
        expect(getObservation(db, userRow.id)?.status).toBe("forgotten")
        expect(getObservation(db, pbCopy.id)?.status).toBe("active")
        expect(getObservation(db, w2Copy.id)?.status).toBe("active")
        expect(scopeOf(db, "content", contentHash(shared))).toEqual(boundary)
        expect(scopeOf(db, "content", contentHash(personal))).toEqual(boundary)
        expect(scopeOf(db, "observation", wsRow.id)).toEqual(boundary)
        expect(scopeOf(db, "observation", userRow.id)).toEqual(boundary)
      }
      check(h.db)
      expect((await scrubBackups(h.db, h.dir)).scrubbed).toBe(1)
      const bak = await openDatabase(file, { create: false })
      try {
        check(bak)
      } finally {
        bak.close()
      }
      restoreBackup(h.db, file)
      check(h.db)
      applySuppressions(h.db)
      check(h.db)
    } finally {
      h.close()
    }
  })

  test("the backup-scrub marker commits with the forget, even when the follow-up work throws", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      const { workspace, projectId, sessionId } = seed(db)
      const a = putObservation(db, { workspace, projectId, sessionId, content: "marker secret about the copper lantern" })
      backupNow(db, env.config.dataDir, 5, T0)
      db.exec("CREATE TEMP TRIGGER om_test_marker BEFORE INSERT ON runtime_state WHEN NEW.key = 'scrub_pending' BEGIN SELECT RAISE(ABORT, 'marker write failed'); END")
      await expect(env.engine.forget([a.id], { actor: "user", reason: "forget" })).rejects.toThrow(/marker write failed/)
      expect(getObservation(db, a.id)?.status).toBe("active")
      db.exec("DROP TRIGGER om_test_marker")
      storeEmbedding(db, "orphan-hash", "m", new Float32Array([1]))
      db.exec("CREATE TEMP TRIGGER om_test_prune BEFORE DELETE ON embeddings BEGIN SELECT RAISE(ABORT, 'prune failed'); END")
      const r = await env.engine.forget([a.id], { actor: "user", reason: "forget" })
      expect(r.observationIds).toEqual([a.id])
      expect(scrubPending(db)).toBeTruthy()
      db.exec("DROP TRIGGER om_test_prune")
    } finally {
      await env.close()
    }
  })

  test("a backup that appears after the scrub, behind the suppression watermark, is scrubbed on tick", async () => {
    const env = await openEngine()
    const token = "zqwatermarkkite"
    const content = `The spare key code is ${token} under the mat`
    try {
      const db = env.engine.db
      const { workspace, projectId, sessionId } = seed(db)
      const a = putObservation(db, { workspace, projectId, sessionId, content })
      storeEmbedding(db, contentHash(content), "m", new Float32Array([1, 2]))
      const early = backupNow(db, tempDir(), 5, T0)
      const r = await env.engine.forget([a.id], { actor: "user", reason: "forget", awaitScrub: true })
      expect(r.scrubPending).toBe(false)
      mkdirSync(backupDir(env.config.dataDir), { recursive: true })
      const late = join(backupDir(env.config.dataDir), basename(early))
      renameSync(early, late)
      const gen = suppressionGeneration(db)
      expect(backupWatermark(db, late)!).toBeLessThan(gen)
      await env.engine.tick(Date.now())
      for (let i = 0; i < 250 && backupWatermark(db, late) !== gen; i++) await Bun.sleep(20)
      expect(backupWatermark(db, late)).toBe(gen)
      expect(readFileSync(late).toString("latin1")).not.toContain(token)
      const bak = await openDatabase(late, { create: false })
      try {
        expect(getObservation(bak, a.id)?.status).toBe("forgotten")
        expect(bak.prepare("SELECT COUNT(*) AS n FROM embeddings").get<{ n: number }>()!.n).toBe(0)
      } finally {
        bak.close()
      }
    } finally {
      await env.close()
    }
  })

  test("a backup without a watermark (made before watermarks) is scrubbed when the engine opens", async () => {
    const dir = tempDir()
    const config = defaultConfig(dir)
    const dbPath = join(dir, "memory.db")
    const token = "zqoldbackupfern"
    const db = await openDb(dbPath)
    const { workspace, projectId, sessionId } = seed(db)
    const a = putObservation(db, { workspace, projectId, sessionId, content: `The vault combination is ${token} forty two` })
    const file = backupNow(db, config.dataDir, 5, T0)
    const bak = await openDatabase(file, { create: false })
    const marker = JSON.parse(bak.prepare("SELECT value FROM meta WHERE key = 'backup_of'").get<{ value: string }>()!.value)
    delete marker.watermark
    bak.prepare("UPDATE meta SET value = ? WHERE key = 'backup_of'").run(JSON.stringify(marker))
    bak.close()
    forgetObservations(db, [a.id], { actor: "user", reason: "forget" })
    db.close()
    const engine = await MemoryEngine.open(config, silent, dbPath)
    try {
      const gen = suppressionGeneration(engine.db)
      for (let i = 0; i < 250 && backupWatermark(engine.db, file) !== gen; i++) await Bun.sleep(20)
      expect(backupWatermark(engine.db, file)).toBe(gen)
      expect(readFileSync(file).toString("latin1")).not.toContain(token)
    } finally {
      await engine.close()
    }
  })

  test("a forget empties the WAL of forgotten bytes, and tick retries while a reader holds it", async () => {
    const env = await openEngine()
    const dbPath = join(env.dir, "memory.db")
    const walHas = (t: string) => existsSync(`${dbPath}-wal`) && readFileSync(`${dbPath}-wal`).toString("latin1").includes(t)
    try {
      const db = env.engine.db
      const { workspace, projectId, sessionId } = seed(db)
      const a = putObservation(db, { workspace, projectId, sessionId, content: "The alarm pin is zqwalfirst nine" })
      expect(walHas("zqwalfirst")).toBe(true)
      const r = await env.engine.forget([a.id], { actor: "user", reason: "forget" })
      expect(r.scrubPending).toBe(false)
      expect(walTruncatePending(db)).toBe(false)
      expect(walHas("zqwalfirst")).toBe(false)

      const b = putObservation(db, { workspace, projectId, sessionId, content: "The gate pin is zqwalsecond five" })
      const reader = await openDatabase(dbPath)
      try {
        reader.exec("BEGIN")
        reader.prepare("SELECT COUNT(*) AS n FROM observations").get()
        await env.engine.forget([b.id], { actor: "user", reason: "forget" })
        expect(walTruncatePending(db)).toBe(true)
        reader.exec("COMMIT")
      } finally {
        reader.close()
      }
      await env.engine.tick(Date.now())
      expect(walTruncatePending(db)).toBe(false)
      expect(walHas("zqwalsecond")).toBe(false)
    } finally {
      await env.close()
    }
  })

  test("a failing outbox write does not block a later delete; paths outside the vault fail permanently", async () => {
    const h = await openHarness({ file: true })
    try {
      seed(h.db)
      const vault = h.config.vaultDir
      mkdirSync(join(vault, "learn"), { recursive: true })
      writeFileSync(join(vault, "learn", "blocked"), "a file where a directory is needed")
      const gone = join(vault, "learn", "topics", "gone.md")
      mkdirSync(dirname(gone), { recursive: true })
      writeFileSync(gone, "forgotten topic body")
      queueWrite(h.db, "learn/blocked/INDEX.md", "index body")
      queueWrite(h.db, "../escape.md", "escaped body")
      enqueueVaultDelete(h.db, "learn/topics/gone.md", T0)
      const logs: string[] = []
      const res = materializeOutbox(h.db, vault, "owner-a", T0, { log: (_l, msg) => logs.push(msg) })
      expect(existsSync(gone)).toBe(false)
      expect(res.failed).toBe(2)
      expect(logs.length).toBe(2)
      const row = (rel: string) =>
        h.db.prepare("SELECT state, attempts, next_attempt_at FROM vault_outbox WHERE rel_path = ?").get<{ state: string; attempts: number; next_attempt_at: number | null }>(rel)!
      expect(row("learn/blocked/INDEX.md")).toMatchObject({ state: "pending", attempts: 1 })
      expect(row("learn/blocked/INDEX.md").next_attempt_at!).toBeGreaterThan(T0)
      expect(row("../escape.md").state).toBe("failed")
      expect(existsSync(join(vault, "..", "escape.md"))).toBe(false)
      expect(readdirSync(join(vault, "learn")).filter((f) => f.includes("om-tmp"))).toEqual([])
      rmSync(join(vault, "learn", "blocked"))
      expect(materializeOutbox(h.db, vault, "owner-a", T0 + 1).written).toBe(0)
      expect(materializeOutbox(h.db, vault, "owner-a", T0 + 10 * 60_000).written).toBe(1)
      expect(readFileSync(join(vault, "learn", "blocked", "INDEX.md"), "utf8")).toBe("index body")
      expect(row("../escape.md").state).toBe("failed")
    } finally {
      h.close()
    }
  })

  test("vault writes and deletes never follow a junction or symlink out of the vault", async () => {
    const h = await openHarness({ file: true })
    try {
      seed(h.db)
      const vault = h.config.vaultDir
      const outside = join(h.dir, "outside")
      mkdirSync(outside, { recursive: true })
      mkdirSync(join(vault, "learn"), { recursive: true })
      writeFileSync(join(outside, "keep.md"), "a file outside the vault")
      try {
        symlinkSync(outside, join(vault, "learn", "linked"), "junction")
      } catch {
        return
      }
      queueWrite(h.db, "learn/linked/evil.md", "escaped through a link")
      enqueueVaultDelete(h.db, "learn/linked/keep.md", T0)
      const res = materializeOutbox(h.db, vault, "owner-a", T0)
      expect(res.failed).toBe(2)
      expect(existsSync(join(outside, "evil.md"))).toBe(false)
      expect(existsSync(join(outside, "keep.md"))).toBe(true)
      const states = h.db.prepare("SELECT state FROM vault_outbox WHERE rel_path LIKE 'learn/linked/%'").all<{ state: string }>()
      expect(states.map((s) => s.state)).toEqual(["failed", "failed"])
    } finally {
      h.close()
    }
  })

  test("restore keeps a vault delete that was still pending", async () => {
    const h = await openHarness({ file: true })
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      putObservation(h.db, { workspace, projectId, sessionId, content: "a durable note for the backup" })
      const file = backupNow(h.db, h.dir, 10, T0)
      const gone = join(h.config.vaultDir, "learn", "topics", "gone.md")
      mkdirSync(dirname(gone), { recursive: true })
      writeFileSync(gone, "forgotten topic body")
      enqueueVaultDelete(h.db, "learn/topics/gone.md", T0 + 1)
      restoreBackup(h.db, file)
      const pending = h.db
        .prepare("SELECT COUNT(*) AS n FROM vault_outbox WHERE rel_path = ? AND content = '' AND state = 'pending'")
        .get<{ n: number }>("learn/topics/gone.md")!.n
      expect(pending).toBe(1)
      materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0 + 2)
      expect(existsSync(gone)).toBe(false)
    } finally {
      h.close()
    }
  })

  test("a user forget from a session view is global; an agent forget with the same ctx stays scoped", async () => {
    const env = await openEngine()
    try {
      const db = env.engine.db
      seed(db, { workspace: "w1", projectId: "pA", sessionId: "sA" })
      seed(db, { workspace: "w2", projectId: "pB", sessionId: "sB" })
      const texts = {
        user: "The passport number ends in seven seven one",
        agent: "The staging database password rotates every friday",
        legacy: "The office door code changes on the first of the month",
      }
      const rows = Object.fromEntries(
        Object.entries(texts).map(([k, content]) => [
          k,
          {
            mine: putObservation(db, { workspace: "w1", projectId: "pA", sessionId: "sA", content }).id,
            other: putObservation(db, { workspace: "w2", projectId: "pB", sessionId: "sB", content }).id,
          },
        ]),
      ) as Record<keyof typeof texts, { mine: string; other: string }>
      const ctx = env.engine.contextForSession("sA")!
      const status = (id: string) => getObservation(db, id)?.status

      const skipped = await env.engine.forget([rows.user.mine, rows.user.other], { actor: "user", reason: "dashboard", ctx, scope: "global" })
      expect(skipped.skipped).toEqual([rows.user.other])
      expect(status(rows.user.mine)).toBe("forgotten")
      expect(status(rows.user.other)).toBe("forgotten")
      expect(scopeOf(db, "content", contentHash(texts.user))).toBeNull()

      await env.engine.forget([rows.agent.mine], { actor: "agent", reason: "agent forget", ctx })
      expect(status(rows.agent.mine)).toBe("forgotten")
      expect(status(rows.agent.other)).toBe("active")
      expect(scopeOf(db, "content", contentHash(texts.agent))).toEqual([{ w: "w1", p: "pA" }])

      await env.engine.forget([rows.legacy.mine], { actor: "user", reason: "dashboard", ctx })
      expect(status(rows.legacy.other)).toBe("active")
    } finally {
      await env.close()
    }
  })

  test("purgeSources 'sources' and forgetSession reach the fork copies of forgotten content", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId } = seed(h.db, { sessionId: "src" })
      for (const s of ["fork", "src2", "fork2"]) seed(h.db, { sessionId: s })
      const part = (msg: string) => h.db.prepare("SELECT id, text, suppressed FROM source_parts WHERE message_id = ?").get<{ id: string; text: string; suppressed: number }>(msg)!
      const secret = "My bank PIN is zqforkpin and I keep forgetting it"
      ingest(h.db, "src", [userMsg(secret, { id: "m1", sessionID: "src" })])
      ingest(h.db, "fork", [userMsg(secret, { id: "m1f", sessionID: "fork" })])
      recordForkLineage(h.db, "fork", { sourceSessionID: "src", messages: { m1: "m1f" } }, T0)
      const o = putObservation(h.db, {
        workspace,
        projectId,
        sessionId: "src",
        content: "The user keeps forgetting their bank PIN",
        sources: [{ sessionId: "src", startMessageId: "m1", endMessageId: "m1", startSeq: 1, endSeq: 1, partIds: [part("m1").id], transformVersion: 1 }],
      })
      forgetObservations(h.db, [o.id], { actor: "user", reason: "forget", purgeSources: "sources" })
      expect(part("m1")).toMatchObject({ text: "[forgotten]", suppressed: 1 })
      expect(part("m1f")).toMatchObject({ text: "[forgotten]", suppressed: 1 })
      expect(h.db.prepare("SELECT 1 FROM suppressions WHERE kind = 'part' AND value = ?").get(part("m1f").id)).toBeTruthy()

      const other = "The spare house key hides under the zqforkstone"
      ingest(h.db, "src2", [userMsg(other, { id: "n1", sessionID: "src2" })])
      ingest(h.db, "fork2", [userMsg(other, { id: "n1f", sessionID: "fork2" })])
      recordForkLineage(h.db, "fork2", { sourceSessionID: "src2", messages: { n1: "n1f" } }, T0)
      const copied = putObservation(h.db, {
        workspace,
        projectId,
        sessionId: "fork2",
        content: "The spare key is kept under a garden stone",
        sources: [{ sessionId: "fork2", startMessageId: "n1f", endMessageId: "n1f", startSeq: 1, endSeq: 1, transformVersion: 1 }],
      })
      forgetSession(h.db, "src2", "user")
      expect(part("n1f")).toMatchObject({ text: "[forgotten]", suppressed: 1 })
      expect(getObservation(h.db, copied.id)?.status).toBe("forgotten")
      expect(JSON.stringify(h.db.prepare("SELECT text FROM source_parts").all())).not.toMatch(/zqfork/)
    } finally {
      h.close()
    }
  })

  test("a scoped suppression does not withhold vectors from out-of-scope copies; suppressed text is never sent", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { workspace: "w1", projectId: "pA", sessionId: "sA" })
      seed(h.db, { workspace: "w1", projectId: "pB", sessionId: "sB" })
      const text = "The deploy key for the billing service lives in the ops vault"
      const proposed = "The on-call rota is shared through a private calendar link"
      const mine = putObservation(h.db, { workspace: "w1", projectId: "pA", sessionId: "sA", content: text })
      const theirs = putObservation(h.db, { workspace: "w1", projectId: "pB", sessionId: "sB", content: text })
      const mine2 = putObservation(h.db, { workspace: "w1", projectId: "pA", sessionId: "sA", content: proposed })
      putObservation(h.db, { workspace: "w1", projectId: "pB", sessionId: "sB", content: proposed, status: "pending_review", targetScope: "workspace" })
      const ctx = { projectId: "pA", workspace: "w1" }
      forgetObservations(h.db, [mine.id, mine2.id], { actor: "agent", reason: "agent forget", ctx })
      expect(getObservation(h.db, theirs.id)?.status).toBe("active")
      const sent: string[] = []
      const embedder: Embedder = {
        model: "m",
        embed: async (texts) => {
          sent.push(...texts)
          return texts.map(() => new Float32Array([1, 0]))
        },
      }
      await backfillEmbeddings(h.db, embedder, { batchSize: 8 })
      expect(sent).toEqual([text])
      expect(h.db.prepare("SELECT 1 FROM embeddings WHERE content_hash = ?").get(contentHash(text))).toBeTruthy()
      expect(h.db.prepare("SELECT 1 FROM embeddings WHERE content_hash = ?").get(contentHash(proposed))).toBeFalsy()
    } finally {
      h.close()
    }
  })

  test("close waits for the background backup scrub before closing the database", async () => {
    const dir = tempDir()
    const config = defaultConfig(dir)
    const logs: string[] = []
    const engine = await MemoryEngine.open(config, (_level, msg) => logs.push(msg), join(dir, "memory.db"))
    const db = engine.db
    const { workspace, projectId, sessionId } = seed(db)
    const a = putObservation(db, { workspace, projectId, sessionId, content: "close secret about the amber door" })
    for (let i = 0; i < 3; i++) backupNow(db, config.dataDir, 5, T0 + i * 60_000)
    const r = await engine.forget([a.id], { actor: "user", reason: "forget" })
    expect(r.scrubPending).toBe(true)
    await engine.close()
    expect(logs.filter((m) => /scrub/.test(m))).toEqual([])
    rmSync(backupDir(config.dataDir), { recursive: true })
    const again = await openDatabase(join(dir, "memory.db"), { create: false })
    try {
      expect(scrubPending(again)?.error).toBeUndefined()
    } finally {
      again.close()
    }
  })
})
