import "./hermetic"
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  contentHash,
  getObservation,
  materializeOutbox,
  storeEmbedding,
  topicGenerations,
  upsertTopic,
  walTruncatePending,
} from "@opencode-memory/core"
import {
  T0,
  ScriptedRunner,
  adapter,
  cleanupAll,
  cleanupDir,
  openEngine,
  tempDir,
  userMessage,
} from "./fixtures"

afterAll(cleanupAll)

function allFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = join(root, entry.name)
    return entry.isDirectory() ? allFiles(full) : [full]
  })
}

describe("acceptance: irreversible forget workflow", () => {
  test("scrubs live indexes, sources, snapshots, vault generations, backups, WAL, and survives restart", async () => {
    const dir = tempDir()
    const dbPath = join(dir, "memory.db")
    const runner = new ScriptedRunner()
    const h = await openEngine({ dir, dbPath, runner })
    const instance = adapter({ runner, directory: dir })
    const secret = "The cobalt locker phrase is zephyr-magnolia-731"
    let id = ""
    try {
      h.engine.register(instance, T0)
      h.engine.trackSession(instance, { id: "forget-session" }, T0)
      const source = userMessage("forget-session", "secret-message", secret, T0)
      h.engine.ingest("forget-session", [source], { now: T0 })
      const saved = h.engine.remember(
        h.engine.context("project-a", "forget-session"),
        { content: secret, actor: "user", scope: "project", sessionId: "forget-session" },
        T0,
      )
      if (!saved.ok) throw new Error(saved.error)
      id = saved.id
      storeEmbedding(h.engine.db, contentHash(secret), "acceptance-vector", new Float32Array([0.2, 0.4, 0.6]))
      const topic = upsertTopic(
        h.engine.db,
        {
          scopeKey: "project:project-a",
          slug: "locker",
          title: "Locker",
          summary: secret,
          sections: [{ heading: "Sensitive", bullets: [{ text: secret, refs: [id] }] }],
          actor: "acceptance",
        },
        T0,
      )
      materializeOutbox(h.engine.db, h.config.vaultDir, "acceptance", T0)
      const built = await h.engine.buildInjection("forget-session", "cobalt locker", "request-before-forget")
      expect(built?.block).toContain("cobalt locker")
      h.engine.commitInjection("forget-session", "request-before-forget", "build", "fake/model-a")
      expect(h.engine.latestSnapshot("forget-session")).toBeTruthy()
      const backupPath = h.engine.backupNow()
      expect(readFileSync(backupPath).length).toBeGreaterThan(0)

      const forgotten = await h.engine.forget([id], {
        actor: "user",
        reason: "acceptance erasure",
        purgeSources: "sources",
        awaitScrub: true,
      })
      expect(forgotten.observationIds).toContain(id)
      expect(forgotten.partsPurged).toBe(1)
      expect(forgotten.snapshotsPurged).toBeGreaterThanOrEqual(1)
      expect(forgotten.backupsFailed ?? 0).toBe(0)
      expect(forgotten.scrubPending).toBe(false)
      expect(getObservation(h.engine.db, id)).toMatchObject({ status: "forgotten", content: "[forgotten]" })
      expect(h.engine.search(h.engine.context("project-a", "forget-session"), "zephyr magnolia")).toEqual([])
      if (h.engine.db.hasFts5) {
        expect(h.engine.db.prepare("SELECT observation_id FROM observations_fts WHERE observation_id = ?").get(id)).toBeUndefined()
      }
      expect(h.engine.db.prepare("SELECT COUNT(*) AS n FROM embeddings").get<{ n: number }>()!.n).toBe(0)
      expect(h.engine.db.prepare("SELECT text, suppressed FROM source_parts WHERE message_id = 'secret-message'").get()).toMatchObject({
        text: "[forgotten]",
        suppressed: 1,
      })
      expect(h.engine.snapshots("forget-session")).toEqual([])
      expect(topicGenerations(h.engine.db, topic.id).every((generation) => !JSON.stringify(generation).includes("zephyr-magnolia"))).toBe(true)
      materializeOutbox(h.engine.db, h.config.vaultDir, "acceptance", T0 + 1_000)
      const outbox = h.engine.db.prepare("SELECT state, content FROM vault_outbox").all<{ state: string; content: string }>()
      expect(outbox.every((row) => !row.content.includes("zephyr-magnolia"))).toBe(true)
      expect(outbox.some((row) => row.state === "written")).toBe(true)
      for (const file of allFiles(h.config.vaultDir)) expect(readFileSync(file, "utf8")).not.toContain("zephyr-magnolia")
      for (const backup of h.engine.backups()) expect(readFileSync(backup.path).toString("latin1")).not.toContain("zephyr-magnolia")
      expect(walTruncatePending(h.engine.db)).toBe(false)
    } finally {
      await h.engine.close()
    }

    const wal = `${dbPath}-wal`
    if (existsSync(wal)) expect(readFileSync(wal).toString("latin1")).not.toContain("zephyr-magnolia")
    const reopened = await openEngine({ dir, dbPath, runner })
    const reopenedAdapter = adapter({ runner, directory: dir })
    try {
      reopened.engine.register(reopenedAdapter, T0 + 10_000)
      expect(getObservation(reopened.engine.db, id)).toMatchObject({ status: "forgotten", content: "[forgotten]" })
      expect(reopened.engine.search(reopened.engine.context("project-a", "forget-session"), "cobalt locker")).toEqual([])
      reopened.engine.ingest("forget-session", [userMessage("forget-session", "secret-message", secret, T0)], { now: T0 + 10_000 })
      expect(reopened.engine.db.prepare("SELECT text, suppressed FROM source_parts WHERE message_id = 'secret-message'").get()).toMatchObject({
        text: "[forgotten]",
        suppressed: 1,
      })
      const regenerated = reopened.engine.remember(
        reopened.engine.context("project-a", "forget-session"),
        { content: secret, actor: "user", scope: "project", sessionId: "forget-session" },
        T0 + 10_000,
      )
      expect(regenerated).toMatchObject({ ok: false, status: 409 })
    } finally {
      await reopened.engine.close()
      cleanupDir(dir)
    }
  })

  test("a scoped agent forget skips foreign rows; a later global forget suppresses regeneration everywhere", async () => {
    const h = await openEngine()
    const runner = new ScriptedRunner()
    const dirB = tempDir()
    const a = adapter({ runner, directory: h.dir, id: "a", projectId: "project-a", workspace: "workspace-a" })
    const b = adapter({ runner, directory: dirB, id: "b", projectId: "project-b", workspace: "workspace-b" })
    try {
      h.engine.register(a, T0)
      h.engine.register(b, T0)
      h.engine.trackSession(a, { id: "session-a" }, T0)
      h.engine.trackSession(b, { id: "session-b" }, T0)
      const aRow = h.engine.remember(h.engine.context("project-a", "session-a"), {
        content: "Project A keeps the kestrel ledger in its archive",
        actor: "user",
        scope: "project",
        sessionId: "session-a",
      })
      const bRow = h.engine.remember(h.engine.context("project-b", "session-b"), {
        content: "Project B keeps the osprey ledger in its archive",
        actor: "user",
        scope: "project",
        sessionId: "session-b",
      })
      if (!aRow.ok || !bRow.ok) throw new Error("fixture write failed")

      const scoped = await h.engine.forget([aRow.id, bRow.id], {
        actor: "agent",
        reason: "scoped request",
        ctx: h.engine.context("project-a", "session-a"),
      })
      expect(scoped.observationIds).toEqual([aRow.id])
      expect(scoped.skipped).toEqual([bRow.id])
      expect(getObservation(h.engine.db, bRow.id)?.status).toBe("active")
      const stillAllowed = h.engine.remember(h.engine.context("project-b", "session-b"), {
        content: "Project A keeps the kestrel ledger in its archive",
        actor: "user",
        scope: "project",
        sessionId: "session-b",
      })
      expect(stillAllowed.ok).toBe(true)

      await h.engine.forget([bRow.id], { actor: "user", reason: "global request", scope: "global" })
      const blocked = h.engine.remember(h.engine.context("project-a", "session-a"), {
        content: "Project B keeps the osprey ledger in its archive",
        actor: "user",
        scope: "project",
        sessionId: "session-a",
      })
      expect(blocked).toMatchObject({ ok: false, status: 409 })
    } finally {
      await h.engine.close()
      cleanupDir(h.dir)
      cleanupDir(dirB)
    }
  })
})
