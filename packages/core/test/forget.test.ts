import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { T0, cleanupAllTempDirs, ingest, openDb, openHarness, putObservation, seed, tempDir, userMsg } from "./helpers"
import { forgetObservations } from "../src/forget"
import { insertObservation, getObservation, isSuppressed } from "../src/observations"
import { recordAttempt, upsertConcept, rebuildConcept } from "../src/learning"
import { recordResearch, listClaims, listSources } from "../src/research"
import { enqueueVaultDelete, forgottenTopicLabel, materializeOutbox, rollbackTopic, upsertTopic, parseTopicBody } from "../src/vault"
import { recordContextSnapshot } from "../src/inject"
import { storeEmbedding } from "../src/embeddings"
import { contentHash, hashedShingles } from "../src/util"
import { backupNow, listBackups, restoreBackup, scrubBackups, scrubPending } from "../src/backup"
import { applyReflectorOps } from "../src/reflector"
import { openDatabase } from "../src/sqlite"

afterAll(cleanupAllTempDirs)

describe("forget", () => {
  test("removes content, FTS, embeddings; suppression blocks re-insert and near-duplicates", async () => {
    const h = await openHarness({ file: true })
    try {
      const { sessionId, projectId, workspace } = seed(h.db)
      ingest(h.db, sessionId, [userMsg("The user keeps a secret notebook of recursion proofs in the drawer", { id: "u1" })], { now: T0 })
      const part = h.db.prepare("SELECT id FROM source_parts WHERE message_id = 'u1'").get<{ id: string }>()!
      const content = "The user keeps a secret notebook of recursion proofs in the drawer"
      const { id } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        content,
        sources: [{ sessionId, startMessageId: "u1", endMessageId: "u1", startSeq: 1, endSeq: 1, partIds: [part.id], transformVersion: 1 }],
      })
      storeEmbedding(h.db, contentHash(content), "test-model", new Float32Array([0.1, 0.2, 0.3]))
      if (h.db.hasFts5) {
        const fts = h.db.prepare("SELECT observation_id FROM observations_fts WHERE observation_id = ?").get(id)
        expect(fts).toBeTruthy()
      }
      const result = forgetObservations(h.db, [id], { actor: "user", reason: "requested", purgeSources: "sources" })
      expect(result.observationIds).toEqual([id])
      expect(result.partsPurged).toBe(1)
      const row = getObservation(h.db, id)!
      expect(row.status).toBe("forgotten")
      expect(row.content).toBe("[forgotten]")
      expect(h.db.prepare("SELECT text, suppressed FROM source_parts WHERE id = ?").get<{ text: string; suppressed: number }>(part.id)).toMatchObject({
        text: "[forgotten]",
        suppressed: 1,
      })
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM embeddings").get<{ n: number }>()!.n).toBe(0)
      if (h.db.hasFts5) {
        expect(h.db.prepare("SELECT observation_id FROM observations_fts WHERE observation_id = ?").get(id)).toBeUndefined()
      }
      expect(isSuppressed(h.db, content)).toBe(true)
      const again = insertObservation(h.db, {
        id: "obs_again",
        scopeKind: "project",
        sessionId,
        projectId,
        workspace,
        chunkId: null,
        kind: "fact",
        content,
        eventAt: T0,
        observedAt: T0,
        confidence: 0.8,
        evidenceType: "observed",
        priority: "medium",
        status: "active",
        actor: "test",
        sources: [],
      })
      expect(again.outcome).toBe("suppressed")
      const near = insertObservation(h.db, {
        id: "obs_near",
        scopeKind: "project",
        sessionId,
        projectId,
        workspace,
        chunkId: null,
        kind: "fact",
        content: "The user keeps a secret notebook of recursion proofs in the cabinet",
        eventAt: T0,
        observedAt: T0,
        confidence: 0.8,
        evidenceType: "observed",
        priority: "medium",
        status: "active",
        actor: "test",
        sources: [],
      })
      expect(near.outcome).toBe("suppressed")
    } finally {
      h.close()
    }
  })

  test("cited source parts stay purged after re-ingest", async () => {
    const h = await openHarness()
    try {
      const { sessionId, projectId, workspace } = seed(h.db)
      const msg = userMsg("forgettable cited line about a home address", { id: "u1" })
      ingest(h.db, sessionId, [msg])
      const part = h.db.prepare("SELECT id FROM source_parts WHERE message_id = 'u1'").get<{ id: string }>()!
      const { id } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        content: "User home address was mentioned",
        sources: [{ sessionId, startMessageId: "u1", endMessageId: "u1", startSeq: 1, endSeq: 1, partIds: [part.id], transformVersion: 1 }],
      })
      forgetObservations(h.db, [id], { actor: "user", reason: "forget address", purgeSources: "sources" })
      ingest(h.db, sessionId, [msg], { now: T0 + 10 })
      const part2 = h.db.prepare("SELECT text, suppressed FROM source_parts WHERE id = ?").get<{ text: string; suppressed: number }>(part.id)!
      expect(part2.text).toBe("[forgotten]")
      expect(part2.suppressed).toBe(1)
    } finally {
      h.close()
    }
  })

  test("topic lines citing a forgotten observation are stripped and outbox is forced", async () => {
    const h = await openHarness()
    try {
      const { projectId, workspace, sessionId } = seed(h.db)
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content: "Durable note about quicksort pivot choice" })
      const topic = upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "sorting",
        title: "Sorting",
        summary: "notes on sorting",
        sections: [{ heading: "Pivots", bullets: [{ text: "Quicksort pivot choice", refs: [id] }] }],
        actor: "test",
      })
      forgetObservations(h.db, [id], { actor: "user", reason: "forget", purgeSources: "none" })
      const row = h.db.prepare("SELECT summary, body FROM topics WHERE id = ?").get<{ summary: string; body: string }>(topic.id)!
      expect(row.summary).toBe("")
      expect(row.body).not.toContain(id)
      const parsed = parseTopicBody(row.body)
      expect(parsed.sections.every((s) => s.bullets.every((b) => !b.refs.includes(id)))).toBe(true)
      const outbox = h.db.prepare("SELECT force, state FROM vault_outbox WHERE topic_id = ? AND state = 'pending'").get<{ force: number; state: string }>(topic.id)
      expect(outbox?.force).toBe(1)
    } finally {
      h.close()
    }
  })

  test("learning attempts are removed and the concept is rebuilt or deleted", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const { id } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        kind: "quiz-attempt",
        content: "Independent correct answer on recursion",
        payload: { concept: "recursion", evaluation: "correct", independent: true, hints: 0 },
      })
      recordAttempt(h.db, {
        workspace,
        observationId: id,
        sessionId,
        kind: "quiz-attempt",
        payload: { concept: "recursion", evaluation: "correct", independent: true, hints: 0 },
        at: T0,
        fromRecall: false,
      })
      const conceptId = upsertConcept(h.db, workspace, "recursion", T0)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM learning_attempts").get<{ n: number }>()!.n).toBe(1)
      forgetObservations(h.db, [id], { actor: "user", reason: "forget quiz", purgeSources: "none" })
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM learning_attempts").get<{ n: number }>()!.n).toBe(0)
      expect(h.db.prepare("SELECT id FROM learning_concepts WHERE id = ?").get(conceptId)).toBeUndefined()
      expect(rebuildConcept(h.db, conceptId)).toBe("missing")
    } finally {
      h.close()
    }
  })

  test("a concept with other live evidence is rebuilt rather than deleted", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const quiz = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        scopeKind: "workspace",
        kind: "quiz-attempt",
        content: "Quiz on recursion",
        payload: { concept: "recursion", evaluation: "correct", independent: true, hints: 0 },
      })
      recordAttempt(h.db, {
        workspace,
        observationId: quiz.id,
        sessionId,
        kind: "quiz-attempt",
        payload: { concept: "recursion", evaluation: "correct", independent: true, hints: 0 },
        at: T0,
        fromRecall: false,
      })
      putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        scopeKind: "workspace",
        kind: "misconception",
        content: "User still confuses base cases with recursive cases",
        payload: { concept: "recursion" },
      })
      const conceptId = upsertConcept(h.db, workspace, "recursion", T0)
      forgetObservations(h.db, [quiz.id], { actor: "user", reason: "forget quiz", purgeSources: "none" })
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM learning_attempts").get<{ n: number }>()!.n).toBe(0)
      expect(h.db.prepare("SELECT id FROM learning_concepts WHERE id = ?").get(conceptId)).toBeTruthy()
      expect(rebuildConcept(h.db, conceptId)).toBe("rebuilt")
    } finally {
      h.close()
    }
  })

  test("claims, evidence, and unused sources are cleaned", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const { id } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        kind: "claim",
        content: "Water boils at 100C at sea level",
        payload: { claim: "Water boils at 100C at sea level", url: "https://example.com/boil", quotation: "boils at 100" },
      })
      recordResearch(h.db, {
        workspace,
        observationId: id,
        kind: "claim",
        content: "Water boils at 100C at sea level",
        payload: { claim: "Water boils at 100C at sea level", url: "https://example.com/boil", quotation: "boils at 100" },
        confidence: 0.8,
        at: T0,
      })
      expect(listClaims(h.db, workspace).length).toBe(1)
      expect(listSources(h.db, workspace).length).toBe(1)
      forgetObservations(h.db, [id], { actor: "user", reason: "forget claim", purgeSources: "none" })
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM claim_evidence").get<{ n: number }>()!.n).toBe(0)
      expect(listClaims(h.db, workspace).length).toBe(0)
      expect(listSources(h.db, workspace).length).toBe(0)
    } finally {
      h.close()
    }
  })

  test("context snapshots citing the observation are purged", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content: "injected fact" })
      recordContextSnapshot(h.db, {
        sessionId,
        requestKey: "req1",
        result: { block: `memory ${id}`, ids: [id], tokens: 10, generation: 1, sections: [] },
      })
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM context_snapshots").get<{ n: number }>()!.n).toBe(1)
      forgetObservations(h.db, [id], { actor: "user", reason: "forget", purgeSources: "none" })
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM context_snapshots").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("backupNow then forget then restoreBackup keeps the observation forgotten", async () => {
    const h = await openHarness({ file: true })
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const content = "A unique forgettable fact about a childhood pet named Marmalade"
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content })
      const file = backupNow(h.db, h.dir, 3, T0)
      forgetObservations(h.db, [id], { actor: "user", reason: "forget pet", purgeSources: "none" })
      expect(getObservation(h.db, id)?.status).toBe("forgotten")
      restoreBackup(h.db, file)
      const row = getObservation(h.db, id)!
      expect(row.status).toBe("forgotten")
      expect(row.content).toBe("[forgotten]")
    } finally {
      h.close()
    }
  })
})

function ftsContains(db: Awaited<ReturnType<typeof openDb>>, token: string): boolean {
  if (!db.hasFts5) return false
  const blobs = db.prepare("SELECT block FROM observations_fts_data").all<{ block: Uint8Array | null }>()
  if (blobs.some((r) => r.block && Buffer.from(r.block).toString("latin1").includes(token))) return true
  const content = db.prepare("SELECT * FROM observations_fts_content").all<Record<string, unknown>>()
  return content.some((r) => Object.values(r).some((v) => typeof v === "string" && v.includes(token)))
}

describe("forget review fixes", () => {
  test("forgetting a predecessor keeps its successor", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const old = putObservation(h.db, { workspace, projectId, sessionId, content: "The user lives at 1 Old Street", now: T0 })
      const cur = putObservation(h.db, { workspace, projectId, sessionId, content: "The user lives at 99 New Road", now: T0 + 10 })
      h.db.prepare("UPDATE observations SET status = 'superseded', superseded_by = ? WHERE id = ?").run(cur.id, old.id)
      h.db.prepare("UPDATE observations SET supersedes_id = ? WHERE id = ?").run(old.id, cur.id)
      const r = forgetObservations(h.db, [old.id], { actor: "user", reason: "forget" })
      expect(r.observationIds).toEqual([old.id])
      expect(getObservation(h.db, old.id)?.status).toBe("forgotten")
      expect(getObservation(h.db, cur.id)).toMatchObject({ status: "active", content: "The user lives at 99 New Road" })
    } finally {
      h.close()
    }
  })

  test("forgetting a condensed source forgets the summary and reactivates its siblings", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const pin = putObservation(h.db, { id: "obs_pin", workspace, projectId, sessionId, content: "bank PIN hint is the cat birthday" })
      const pnpm = putObservation(h.db, { id: "obs_pnpm", workspace, projectId, sessionId, content: "project uses pnpm workspaces for installs" })
      const ci = putObservation(h.db, { id: "obs_ci", workspace, projectId, sessionId, content: "CI pipeline runs nightly builds" })
      const refs = new Map([
        ["o1", getObservation(h.db, pin.id)!],
        ["o2", getObservation(h.db, pnpm.id)!],
        ["o3", getObservation(h.db, ci.id)!],
      ])
      applyReflectorOps(
        h.db,
        `project:${projectId}`,
        refs,
        [{ op: "condense", refs: ["o1", "o2", "o3"], content: "Setup notes: pnpm, nightly CI and a PIN hint", kind: "fact" }],
        [pin.id, pnpm.id, ci.id],
        T0 + 10,
      )
      const summary = h.db.prepare("SELECT id FROM observations WHERE kind = 'condensed'").get<{ id: string }>()!.id
      expect(getObservation(h.db, pnpm.id)?.status).toBe("superseded")
      const r = forgetObservations(h.db, [pin.id], { actor: "user", reason: "forget" })
      expect([...r.observationIds].sort()).toEqual([pin.id, summary].sort())
      expect([...(r.reactivated ?? [])].sort()).toEqual([ci.id, pnpm.id].sort())
      for (const id of [pnpm.id, ci.id]) {
        expect(getObservation(h.db, id)).toMatchObject({ status: "active", superseded_by: null })
        const events = h.db.prepare("SELECT type FROM observation_events WHERE observation_id = ?").all<{ type: string }>(id)
        expect(events.some((e) => e.type === "reactivated")).toBe(true)
      }
    } finally {
      h.close()
    }
  })

  test("an explicitly selected summary forgets its direct sources", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const a = putObservation(h.db, { id: "obs_sa", workspace, projectId, sessionId, content: "first source about the attic key" })
      const b = putObservation(h.db, { id: "obs_sb", workspace, projectId, sessionId, content: "second source about the garden shed" })
      const other = putObservation(h.db, { id: "obs_other", workspace, projectId, sessionId, content: "unrelated note about compilers" })
      const refs = new Map([
        ["o1", getObservation(h.db, a.id)!],
        ["o2", getObservation(h.db, b.id)!],
      ])
      applyReflectorOps(h.db, `project:${projectId}`, refs, [{ op: "condense", refs: ["o1", "o2"], content: "Where the keys are kept", kind: "fact" }], [a.id, b.id], T0 + 10)
      const summary = h.db.prepare("SELECT id FROM observations WHERE kind = 'condensed'").get<{ id: string }>()!.id
      const r = forgetObservations(h.db, [summary], { actor: "user", reason: "forget" })
      expect([...r.observationIds].sort()).toEqual([a.id, b.id, summary].sort())
      expect(r.reactivated ?? []).toEqual([])
      expect(getObservation(h.db, other.id)?.status).toBe("active")
    } finally {
      h.close()
    }
  })

  test("purgeSources defaults to none", async () => {
    const h = await openHarness()
    try {
      const { sessionId, projectId, workspace } = seed(h.db)
      ingest(h.db, sessionId, [userMsg("the retained snapshot line about a dentist appointment", { id: "u1" })])
      const part = h.db.prepare("SELECT id, text FROM source_parts WHERE message_id = 'u1'").get<{ id: string; text: string }>()!
      const { id } = putObservation(h.db, {
        workspace,
        projectId,
        sessionId,
        content: "User has a dentist appointment",
        sources: [{ sessionId, startMessageId: "u1", endMessageId: "u1", startSeq: 1, endSeq: 1, partIds: [part.id], transformVersion: 1 }],
      })
      const r = forgetObservations(h.db, [id], { actor: "user", reason: "forget" })
      expect(r.partsPurged).toBe(0)
      expect(h.db.prepare("SELECT text, suppressed FROM source_parts WHERE id = ?").get(part.id)).toMatchObject({ text: part.text, suppressed: 0 })
    } finally {
      h.close()
    }
  })

  test("old generations are scrubbed and rollback never restores forgotten content", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const gone = putObservation(h.db, { workspace, projectId, sessionId, content: "Heap sort is not a stable sort" })
      const keep = putObservation(h.db, { workspace, projectId, sessionId, content: "Merge sort is stable and predictable" })
      const key = `project:${projectId}`
      const topic = upsertTopic(h.db, {
        scopeKey: key,
        slug: "sorting",
        title: "Sorting",
        summary: "notes on heap sort stability",
        sections: [{ heading: "Stability", bullets: [{ text: "Heap sort is not stable", refs: [gone.id] }, { text: "Merge sort is stable", refs: [keep.id] }] }],
        actor: "test",
      })
      upsertTopic(
        h.db,
        { scopeKey: key, slug: "sorting", title: "Sorting", summary: "", sections: [{ heading: "Other", bullets: [{ text: "Merge sort is predictable", refs: [keep.id] }] }], actor: "reflector", merge: true },
        T0 + 10,
      )
      forgetObservations(h.db, [gone.id], { actor: "user", reason: "forget" })
      const gens = h.db.prepare("SELECT title, body FROM topic_generations WHERE topic_id = ?").all<{ title: string; body: string }>(topic.id)
      expect(gens.length).toBeGreaterThanOrEqual(2)
      for (const g of gens) {
        expect(g.body).not.toContain(gone.id)
        expect(g.body).not.toContain("Heap sort is not stable")
        expect(g.body).not.toContain("heap sort stability")
      }
      expect(rollbackTopic(h.db, topic.id, 1, "user", T0 + 20)).toBe(true)
      const row = h.db.prepare("SELECT title, body, summary FROM topics WHERE id = ?").get<{ title: string; body: string; summary: string }>(topic.id)!
      expect(row.title).toBe("Sorting")
      expect(row.body).toContain("Merge sort is stable")
      expect(row.body).not.toContain("Heap sort")
      expect(row.summary ?? "").not.toContain("heap sort")
    } finally {
      h.close()
    }
  })

  test("an emptied topic is relabelled in every generation and rollback keeps the label", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const gone = putObservation(h.db, { workspace, projectId, sessionId, content: "Therapy sessions happen on Tuesdays" })
      const topic = upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "therapy",
        title: "Therapy schedule",
        summary: "",
        sections: [{ heading: "Therapy", bullets: [{ text: "Therapy on Tuesdays", refs: [gone.id] }] }],
        actor: "test",
      })
      forgetObservations(h.db, [gone.id], { actor: "user", reason: "forget" })
      const label = forgottenTopicLabel(topic.id)
      const row = h.db.prepare("SELECT title, slug, rel_path FROM topics WHERE id = ?").get<{ title: string; slug: string; rel_path: string }>(topic.id)!
      expect(row.title).toBe(label)
      expect(row.slug.startsWith("forgotten-")).toBe(true)
      expect(row.rel_path).not.toContain("therapy")
      for (const g of h.db.prepare("SELECT title, body FROM topic_generations WHERE topic_id = ?").all<{ title: string; body: string }>(topic.id)) {
        expect(g.title).toBe(label)
        expect(g.body.toLowerCase()).not.toContain("therapy")
      }
      rollbackTopic(h.db, topic.id, 1, "user", T0 + 20)
      const back = h.db.prepare("SELECT title, body FROM topics WHERE id = ?").get<{ title: string; body: string }>(topic.id)!
      expect(back.title).toBe(label)
      expect(back.body.toLowerCase()).not.toContain("therapy")
    } finally {
      h.close()
    }
  })

  test("headings and bullet text matching forgotten content are removed", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const secret = "Quarterly salary negotiation with Globex"
      const gone = putObservation(h.db, { workspace, projectId, sessionId, content: secret })
      const keep = putObservation(h.db, { workspace, projectId, sessionId, content: "Weekly planning happens on Monday" })
      const topic = upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "work",
        title: "Work",
        summary: "",
        sections: [
          { heading: secret, bullets: [{ text: "Weekly planning on Monday", refs: [keep.id] }] },
          { heading: "Misc", bullets: [{ text: secret, refs: [keep.id] }, { text: "Planning is weekly", refs: [keep.id] }] },
        ],
        actor: "test",
      })
      const r = forgetObservations(h.db, [gone.id], { actor: "user", reason: "forget" })
      expect(r.topicsTouched).toContain(topic.id)
      const body = h.db.prepare("SELECT body FROM topics WHERE id = ?").get<{ body: string }>(topic.id)!.body
      expect(body).not.toContain("Globex")
      expect(body).toContain("Weekly planning on Monday")
      expect(body).toContain("Planning is weekly")
      for (const g of h.db.prepare("SELECT body FROM topic_generations WHERE topic_id = ?").all<{ body: string }>(topic.id)) expect(g.body).not.toContain("Globex")
    } finally {
      h.close()
    }
  })

  test("a suppressed title renames the slug and file and deletes the old file", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const secret = "Project Nightingale acquisition"
      const gone = putObservation(h.db, { workspace, projectId, sessionId, content: secret })
      const keep = putObservation(h.db, { workspace, projectId, sessionId, content: "Due diligence checklist is shared" })
      const topic = upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "project-nightingale-acquisition",
        title: secret,
        summary: "",
        sections: [{ heading: "Checklist", bullets: [{ text: "Checklist is shared", refs: [keep.id] }] }],
        actor: "test",
      })
      mkdirSync(h.config.vaultDir, { recursive: true })
      materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0)
      const before = h.db.prepare("SELECT rel_path FROM topics WHERE id = ?").get<{ rel_path: string }>(topic.id)!.rel_path
      expect(existsSync(join(h.config.vaultDir, before))).toBe(true)
      forgetObservations(h.db, [gone.id], { actor: "user", reason: "forget" })
      const after = h.db.prepare("SELECT slug, rel_path, title FROM topics WHERE id = ?").get<{ slug: string; rel_path: string; title: string }>(topic.id)!
      expect(after.title).toBe(forgottenTopicLabel(topic.id))
      expect(after.slug).not.toContain("nightingale")
      expect(after.rel_path).not.toContain("nightingale")
      materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0 + 10)
      expect(existsSync(join(h.config.vaultDir, before))).toBe(false)
      expect(readFileSync(join(h.config.vaultDir, after.rel_path), "utf8")).toContain("Checklist is shared")
      const outbox = h.db.prepare("SELECT content FROM vault_outbox WHERE content != ''").all<{ content: string }>()
      for (const o of outbox) expect(o.content).not.toContain("Nightingale")
    } finally {
      h.close()
    }
  })

  test("snapshots that injected a forgotten topic summary are purged", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const gone = putObservation(h.db, { workspace, projectId, sessionId, content: "Viewing the Lisbon apartment on Saturday" })
      upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "travel",
        title: "Travel",
        summary: "Weekend plans involve the Lisbon apartment viewing",
        sections: [{ heading: "Plans", bullets: [{ text: "Lisbon apartment viewing", refs: [gone.id] }] }],
        actor: "test",
      })
      recordContextSnapshot(h.db, {
        sessionId,
        requestKey: "req-topic",
        result: { block: `## Workspace\n- Topic "Travel": Weekend plans involve the Lisbon apartment viewing`, ids: [], tokens: 12, generation: 1, sections: [] },
      })
      recordContextSnapshot(h.db, {
        sessionId,
        requestKey: "req-other",
        result: { block: "## Workspace\n- unrelated line", ids: [], tokens: 4, generation: 1, sections: [] },
      })
      const r = forgetObservations(h.db, [gone.id], { actor: "user", reason: "forget" })
      expect(r.snapshotsPurged).toBeGreaterThanOrEqual(1)
      const left = h.db.prepare("SELECT request_key FROM context_snapshots").all<{ request_key: string }>()
      expect(left.map((s) => s.request_key)).toEqual(["req-other"])
    } finally {
      h.close()
    }
  })

  test("a failed vault delete stays pending and is retried after backoff", async () => {
    const h = await openHarness()
    try {
      seed(h.db)
      const rel = "learn/topics/stuck.md"
      const blocker = join(h.config.vaultDir, rel)
      mkdirSync(blocker, { recursive: true })
      enqueueVaultDelete(h.db, rel, T0)
      const logs: string[] = []
      const first = materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0, { log: (_l, msg) => logs.push(msg) })
      expect(first.failed).toBe(1)
      expect(logs.length).toBe(1)
      const row = () =>
        h.db
          .prepare("SELECT state, attempts, next_attempt_at, error FROM vault_outbox WHERE rel_path = ? ORDER BY id DESC LIMIT 1")
          .get<{ state: string; attempts: number; next_attempt_at: number; error: string | null }>(rel)!
      expect(row()).toMatchObject({ state: "pending", attempts: 1 })
      expect(row().next_attempt_at).toBeGreaterThan(T0)
      expect(row().error).toBeTruthy()
      expect(materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0 + 1).failed).toBe(0)
      expect(row().attempts).toBe(1)
      rmSync(blocker, { recursive: true, force: true })
      writeFileSync(blocker, "forgotten topic body")
      const retried = materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0 + 10 * 60_000)
      expect(retried.written).toBeGreaterThanOrEqual(1)
      expect(row().state).toBe("written")
      expect(existsSync(blocker)).toBe(false)
    } finally {
      h.close()
    }
  })

  test("forgotten tokens leave the live FTS index", async () => {
    const h = await openHarness()
    try {
      if (!h.db.hasFts5) return
      const { workspace, projectId, sessionId } = seed(h.db)
      putObservation(h.db, { workspace, projectId, sessionId, content: "unrelated durable note about graphs" })
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content: "The locker code is zzqvortex seven" })
      expect(ftsContains(h.db, "zzqvort")).toBe(true)
      forgetObservations(h.db, [id], { actor: "user", reason: "forget" })
      expect(ftsContains(h.db, "zzqvort")).toBe(false)
    } finally {
      h.close()
    }
  })

  test("scrub: a failing backup does not stop the others; deleted files stay deleted; order, mtimes and bytes", async () => {
    const h = await openHarness({ file: true })
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      putObservation(h.db, { workspace, projectId, sessionId, content: "unrelated durable note about graphs" })
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content: "The locker code is zzqvortex seven" })
      const files = [0, 1, 2, 3].map((i) => backupNow(h.db, h.dir, 10, T0 + i * 60_000))
      const listed = listBackups(h.dir)
      expect(listed.map((b) => b.path)).toEqual([...files].reverse())
      listed.forEach((b, i) => utimesSync(b.path, new Date(T0), new Date(T0 + i * 1000)))
      const mtimes = new Map(listBackups(h.dir).map((b) => [b.file, statSync(b.path).mtimeMs]))
      const [newest, second, third, oldest] = listed
      writeFileSync(third.path, "definitely not a sqlite database ".repeat(200))
      unlinkSync(oldest.path)
      forgetObservations(h.db, [id], { actor: "user", reason: "forget" })
      const r = await scrubBackups(h.db, h.dir)
      expect(r.failed).toEqual([third.file])
      expect(r.scrubbed).toBe(2)
      expect(existsSync(oldest.path)).toBe(false)
      expect(listBackups(h.dir).map((b) => b.file)).toEqual([newest.file, second.file, third.file])
      for (const b of [newest, second]) {
        expect(Math.abs(statSync(b.path).mtimeMs - mtimes.get(b.file)!)).toBeLessThan(2000)
        expect(readFileSync(b.path).toString("latin1")).not.toContain("zzqvortex")
        const bak = await openDatabase(b.path, { create: false })
        try {
          expect(getObservation(bak, id)?.status).toBe("forgotten")
          expect(ftsContains(bak, "zzqvort")).toBe(false)
        } finally {
          bak.close()
        }
      }
      expect(scrubPending(h.db)).toMatchObject({ files: [third.file], attempts: 1 })
      unlinkSync(third.path)
      const again = await scrubBackups(h.db, h.dir, { files: [third.file] })
      expect(again.failed).toEqual([])
      expect(scrubPending(h.db)).toBeUndefined()
    } finally {
      h.close()
    }
  })

  test("ensureSchema restores a dropped table and columns when an old database is reopened", async () => {
    const dir = tempDir()
    const path = join(dir, "old.db")
    const db = await openDb(path)
    const text = "The alarm code is written under the doormat"
    db.prepare("INSERT INTO suppressions(kind, value, shingles, reason, created_at) VALUES ('content', ?, ?, 'user_forget', ?)").run(
      contentHash(text),
      JSON.stringify(hashedShingles(text)),
      T0,
    )
    db.exec("DROP TABLE suppression_shingles")
    db.exec("ALTER TABLE suppressions DROP COLUMN scope")
    db.exec("ALTER TABLE vault_outbox DROP COLUMN attempts")
    db.close()
    const again = await openDb(path)
    try {
      const cols = (t: string) => again.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>().map((c) => c.name)
      expect(cols("suppressions")).toContain("scope")
      expect(cols("vault_outbox")).toContain("attempts")
      expect(isSuppressed(again, "The alarm code is written under the doormat today")).toBe(true)
    } finally {
      again.close()
    }
  })

  test("backups with an older schema (no suppression_shingles) are scrubbed and restored", async () => {
    const h = await openHarness({ file: true })
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const content = "Old schema secret about the boathouse key"
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content })
      putObservation(h.db, { workspace, projectId, sessionId, content: "a durable note that stays" })
      const scrubbed = backupNow(h.db, h.dir, 10, T0)
      const restored = backupNow(h.db, h.dir, 10, T0 + 60_000)
      for (const file of [scrubbed, restored]) {
        const bak = await openDatabase(file, { create: false })
        bak.exec("DROP TABLE suppression_shingles")
        bak.exec("ALTER TABLE suppressions DROP COLUMN scope")
        bak.exec("ALTER TABLE vault_outbox DROP COLUMN error")
        bak.close()
      }
      forgetObservations(h.db, [id], { actor: "user", reason: "forget" })
      const r = await scrubBackups(h.db, h.dir, { files: [scrubbed.split(/[\\/]/).pop()!] })
      expect(r).toMatchObject({ scrubbed: 1, failed: [] })
      const bak = await openDatabase(scrubbed, { create: false })
      try {
        expect(getObservation(bak, id)?.status).toBe("forgotten")
        expect(isSuppressed(bak, content)).toBe(true)
      } finally {
        bak.close()
      }
      const out = restoreBackup(h.db, restored)
      expect(out.tables).toBeGreaterThan(0)
      expect(getObservation(h.db, id)?.status).toBe("forgotten")
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE status = 'active'").get<{ n: number }>()!.n).toBe(1)
    } finally {
      h.close()
    }
  })

  test("the prefiltered sweep still forgets reworded copies and leaves unrelated rows alone", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const text = "The user stores the router admin password on a sticky note under the keyboard"
      seed(h.db, { projectId: "proj_b", sessionId: "ses_b" })
      const { id } = putObservation(h.db, { workspace, projectId, sessionId, content: text })
      const reworded = putObservation(h.db, {
        workspace,
        projectId: "proj_b",
        sessionId: "ses_b",
        content: "The user stores the router admin password on a sticky note under the keyboard tray",
      })
      const unrelated = putObservation(h.db, { workspace, projectId, sessionId, content: "The user prefers tabs over spaces in Go code" })
      for (let i = 0; i < 50; i++) putObservation(h.db, { workspace, projectId, sessionId, content: `filler observation number ${i} about compilers` })
      const r = forgetObservations(h.db, [id], { actor: "user", reason: "forget" })
      expect(r.observationIds).toContain(reworded.id)
      expect(getObservation(h.db, reworded.id)?.status).toBe("forgotten")
      expect(getObservation(h.db, unrelated.id)?.status).toBe("active")
    } finally {
      h.close()
    }
  })
})
