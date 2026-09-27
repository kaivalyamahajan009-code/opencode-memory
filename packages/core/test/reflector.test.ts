import { afterAll, describe, expect, test } from "bun:test"
import { FakeRunner, T0, cleanupAllTempDirs, openHarness, putObservation, seed } from "./helpers"
import { applyReflectorOps, reflectScope, validateReflectorOps } from "../src/reflector"
import { forgetObservations } from "../src/forget"
import { getObservation, isSuppressed } from "../src/observations"
import { upsertTopic, parseTopicBody, materializeOutbox, enqueueTopic } from "../src/vault"
import { writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { RunnerError } from "../src/runner"

afterAll(cleanupAllTempDirs)

describe("reflector and vault", () => {
  test("upsertTopic merge keeps omitted sections and drops bullets whose refs are no longer live", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const live = putObservation(h.db, { workspace, projectId, sessionId, content: "live evidence about maps" })
      const dead = putObservation(h.db, { workspace, projectId, sessionId, content: "dead evidence about lists" })
      const first = upsertTopic(h.db, {
        scopeKey: `project:${projectId}`,
        slug: "data-structures",
        title: "Data structures",
        summary: "overview",
        sections: [
          { heading: "Maps", bullets: [{ text: "Hash maps are live", refs: [live.id] }] },
          { heading: "Lists", bullets: [{ text: "Linked lists are dead", refs: [dead.id] }] },
        ],
        actor: "test",
      })
      h.db.prepare("UPDATE observations SET status = 'forgotten', visibility = 'visible' WHERE id = ?").run(dead.id)
      const second = upsertTopic(
        h.db,
        {
          scopeKey: `project:${projectId}`,
          slug: "data-structures",
          title: "Data structures",
          summary: "",
          sections: [{ heading: "Maps", bullets: [{ text: "Hash maps updated", refs: [live.id] }] }],
          actor: "reflector",
          merge: true,
        },
        T0 + 10,
      )
      expect(second.id).toBe(first.id)
      const body = h.db.prepare("SELECT body, summary FROM topics WHERE id = ?").get<{ body: string; summary: string }>(first.id)!
      expect(body.summary).toBe("overview")
      const parsed = parseTopicBody(body.body)
      expect(parsed.sections.map((s) => s.heading)).toEqual(["Maps"])
      expect(parsed.sections[0].bullets.some((b) => b.text.includes("Hash maps updated"))).toBe(true)
      expect(body.body).not.toContain("Linked lists")
    } finally {
      h.close()
    }
  })

  test("validateReflectorOps drops mastery assertions and suppressed text", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const a = putObservation(h.db, { id: "obs_live_a", workspace, projectId, sessionId, content: "first durable fact about trees" })
      const b = putObservation(h.db, { id: "obs_live_b", workspace, projectId, sessionId, content: "second durable fact about trees" })
      forgetObservations(h.db, [b.id], { actor: "user", reason: "forget", purgeSources: "none" })
      const forgottenText = "second durable fact about trees"
      expect(isSuppressed(h.db, forgottenText)).toBe(true)
      const refs = new Map([
        ["o1", getObservation(h.db, a.id)!],
        ["o2", getObservation(h.db, a.id)!],
      ])
      refs.set("o2", getObservation(h.db, a.id)!)
      const validated = validateReflectorOps(
        {
          ops: [
            {
              op: "upsert_topic",
              slug: "trees",
              title: "Trees",
              sections: [
                {
                  heading: "Mastery",
                  bullets: [
                    { text: "The user has mastered binary trees", refs: ["o1"] },
                    { text: "Trees have parent pointers", refs: ["o1"] },
                  ],
                },
              ],
            },
            {
              op: "upsert_topic",
              slug: "forest",
              title: "Forest",
              sections: [
                {
                  heading: "Facts",
                  bullets: [
                    { text: forgottenText, refs: ["o1"] },
                    { text: "Forests contain many trees", refs: ["o1"] },
                  ],
                },
              ],
            },
            { op: "condense", refs: ["o1", "ghost"], content: "too few live refs", kind: "fact" },
            { op: "supersede", oldRef: "o1", newRef: "o1", reason: "same" },
            { op: "append_journey", entry: "a milestone without evidence", refs: [] },
          ],
        },
        refs,
        h.db,
      )
      expect(validated.dropped).toContain("mastery assertion")
      expect(validated.dropped).toContain("forgotten content")
      expect(validated.dropped).toContain("invalid condense")
      expect(validated.dropped).toContain("invalid supersede")
      expect(validated.dropped).toContain("invalid journey")
      const topics = validated.ops.filter((o) => o.op === "upsert_topic")
      expect(topics.length).toBe(1)
      const topic = topics[0]
      expect(topic.op === "upsert_topic" && topic.slug).toBe("trees")
      expect(topic.op === "upsert_topic" && topic.sections[0].bullets).toEqual([{ text: "Trees have parent pointers", refs: ["o1"] }])
    } finally {
      h.close()
    }
  })

  test("condense and supersede ops apply against live refs", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const older = putObservation(h.db, { id: "obs_old", workspace, projectId, sessionId, content: "old conclusion about X", now: T0 })
      const newer = putObservation(h.db, { id: "obs_new", workspace, projectId, sessionId, content: "new conclusion about X", now: T0 + 1000 })
      const extra = putObservation(h.db, { id: "obs_extra", workspace, projectId, sessionId, content: "supporting detail about X", now: T0 + 500 })
      const refs = new Map([
        ["o1", getObservation(h.db, older.id)!],
        ["o2", getObservation(h.db, newer.id)!],
        ["o3", getObservation(h.db, extra.id)!],
      ])
      const applied = applyReflectorOps(
        h.db,
        `project:${projectId}`,
        refs,
        [
          { op: "condense", refs: ["o2", "o3"], content: "Combined conclusion about X", kind: "fact" },
          { op: "supersede", oldRef: "o1", newRef: "o2", reason: "later evidence" },
        ],
        [older.id, newer.id, extra.id],
        T0 + 2000,
      )
      expect(applied.condensed).toBe(1)
      expect(applied.superseded).toBe(1)
      expect(getObservation(h.db, older.id)?.status).toBe("superseded")
      const condensed = h.db.prepare("SELECT content, kind FROM observations WHERE kind = 'condensed'").get<{ content: string; kind: string }>()
      expect(condensed?.content).toBe("Combined conclusion about X")
    } finally {
      h.close()
    }
  })

  test("materializeOutbox writes files, detects an external edit as a conflict, and force overwrites", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const live = putObservation(h.db, { scopeKind: "workspace", workspace, projectId, sessionId, content: "vaulted note" })
      const topic = upsertTopic(h.db, {
        scopeKey: `workspace:${workspace}`,
        slug: "notes",
        title: "Notes",
        summary: "a summary",
        sections: [{ heading: "One", bullets: [{ text: "vaulted note", refs: [live.id] }] }],
        actor: "test",
      })
      const first = materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0)
      expect(first.written).toBeGreaterThanOrEqual(1)
      const rel = h.db.prepare("SELECT rel_path FROM topics WHERE id = ?").get<{ rel_path: string }>(topic.id)!.rel_path
      const path = join(h.config.vaultDir, rel)
      expect(readFileSync(path, "utf8")).toContain("vaulted note")

      const disk = readFileSync(path, "utf8")
      writeFileSync(path, disk.replace("vaulted note", "externally edited note"))
      upsertTopic(
        h.db,
        {
          scopeKey: `workspace:${workspace}`,
          slug: "notes",
          title: "Notes",
          summary: "a summary",
          sections: [{ heading: "One", bullets: [{ text: "second generation", refs: [live.id] }] }],
          actor: "reflector",
          merge: true,
        },
        T0 + 10,
      )
      const conflicted = materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0 + 20)
      expect(conflicted.conflicts).toBeGreaterThanOrEqual(1)
      expect(h.db.prepare("SELECT state FROM topics WHERE id = ?").get<{ state: string }>(topic.id)?.state).toBe("conflict")
      expect(readFileSync(path, "utf8")).toContain("externally edited")

      enqueueTopic(h.db, topic.id, T0 + 30, true)
      const forced = materializeOutbox(h.db, h.config.vaultDir, "owner-a", T0 + 40)
      expect(forced.written).toBeGreaterThanOrEqual(1)
      expect(forced.conflicts).toBe(0)
      expect(readFileSync(path, "utf8")).toContain("second generation")
      expect(readFileSync(path, "utf8")).not.toContain("externally edited")
    } finally {
      h.close()
    }
  })

  test("malformed reflector ops throw invalid_output when every op is schema-invalid", async () => {
    const h = await openHarness()
    try {
      const refs = new Map()
      expect(() => validateReflectorOps({ ops: [{ op: "nope" }, { nope: true }] }, refs, h.db)).toThrow(RunnerError)
    } finally {
      h.close()
    }
  })

  test("reflector race: ops written from a row forgotten mid-run are dropped whole (topic summary, condense)", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      putObservation(h.db, { workspace, projectId, sessionId, content: "Postgres is the primary datastore", now: T0 + 10 })
      const gone = putObservation(h.db, { workspace, projectId, sessionId, content: "The divorce hearing is scheduled for March", now: T0 })
      const runner = new FakeRunner()
      runner.enqueue(async () => {
        forgetObservations(h.db, [gone.id], { actor: "user", reason: "forget" })
        return {
          ops: [
            {
              op: "upsert_topic",
              slug: "life",
              title: "Life and infra",
              summary: "A March court date, and Postgres as the primary store",
              sections: [
                {
                  heading: "Infra",
                  bullets: [
                    { text: "Postgres is primary", refs: ["o1"] },
                    { text: "Court date in March", refs: ["o2"] },
                  ],
                },
              ],
            },
            { op: "condense", refs: ["o1", "o2"], content: "Postgres primary and a March court date", kind: "fact" },
            { op: "upsert_topic", slug: "db", title: "Databases", sections: [{ heading: "Primary", bullets: [{ text: "Postgres is the primary datastore", refs: ["o1"] }] }] },
          ],
        }
      })
      const outcome = await reflectScope({ db: h.db, config: h.config, runner, owner: "race-owner" }, `project:${projectId}`)
      expect(outcome.status).toBe("applied")
      if (outcome.status === "applied") {
        expect(outcome.applied.topics).toBe(1)
        expect(outcome.applied.condensed).toBe(0)
      }
      const topics = h.db.prepare("SELECT slug, title, summary, body FROM topics").all<{ slug: string }>()
      expect(topics.map((t) => t.slug)).toEqual(["db"])
      expect(JSON.stringify(topics)).not.toMatch(/court|march/i)
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE kind = 'condensed'").get<{ n: number }>()!.n).toBe(0)
    } finally {
      h.close()
    }
  })

  test("a bullet citing a plainly superseded row is dropped, not re-pinned to the successor", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const old = putObservation(h.db, { id: "obs_old_ver", workspace, projectId, sessionId, content: "Node 18 is the runtime", now: T0 })
      const cur = putObservation(h.db, { id: "obs_new_ver", workspace, projectId, sessionId, content: "Node 22 is the runtime", now: T0 + 10 })
      const other = putObservation(h.db, { id: "obs_other_ver", workspace, projectId, sessionId, content: "pnpm is the package manager", now: T0 + 20 })
      const key = `project:${projectId}`
      const topic = upsertTopic(h.db, {
        scopeKey: key,
        slug: "stack",
        title: "Stack",
        summary: "",
        sections: [{ heading: "Runtime", bullets: [{ text: "Runs on Node 18", refs: [old.id] }] }],
        actor: "test",
      })
      h.db.prepare("UPDATE observations SET status = 'superseded', superseded_by = ? WHERE id = ?").run(cur.id, old.id)
      upsertTopic(
        h.db,
        { scopeKey: key, slug: "stack", title: "Stack", summary: "", sections: [{ heading: "Tools", bullets: [{ text: "pnpm", refs: [other.id] }] }], actor: "reflector", merge: true },
        T0 + 30,
      )
      const body = h.db.prepare("SELECT body FROM topics WHERE id = ?").get<{ body: string }>(topic.id)!.body
      expect(body).not.toContain("Runs on Node 18")
      expect(body).not.toContain(cur.id)
      expect(body).toContain(other.id)
    } finally {
      h.close()
    }
  })

  test("reflector parents its worker session and records the cost of a failed run", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      seed(h.db, { sessionId: "ses_internal", now: T0 + 50 })
      seed(h.db, { sessionId: "ses_deleted", now: T0 + 60 })
      h.db.prepare("UPDATE sessions SET internal = 1 WHERE id = 'ses_internal'").run()
      h.db.prepare("UPDATE sessions SET deleted_at = ? WHERE id = 'ses_deleted'").run(T0 + 70)
      putObservation(h.db, { workspace, projectId, sessionId, content: "a durable fact that triggers reflection" })
      const runner = new FakeRunner()
      runner.enqueue(() => Object.assign(new RunnerError("aborted", "reflection timed out"), { cost: 0.02, inputTokens: 100, outputTokens: 50, model: "fake" }))
      const outcome = await reflectScope({ db: h.db, config: h.config, runner, owner: "cost-owner" }, `project:${projectId}`)
      expect(outcome.status).toBe("failed")
      expect(runner.requests[0].parentSessionId).toBe(sessionId)
      const op = h.db.prepare("SELECT cost, status FROM operations ORDER BY started_at DESC LIMIT 1").get<{ cost: number; status: string }>()
      expect(op).toMatchObject({ cost: 0.02, status: "failed" })
    } finally {
      h.close()
    }
  })

  test("condensed content, supersede reasons, journey entries and promotion reasons are redacted", async () => {
    const h = await openHarness()
    try {
      const secret = `ghp_${"b".repeat(36)}`
      const { workspace, projectId, sessionId } = seed(h.db)
      const a = putObservation(h.db, { id: "obs_r_a", workspace, projectId, sessionId, content: "token rotation happens monthly", now: T0 })
      const b = putObservation(h.db, { id: "obs_r_b", workspace, projectId, sessionId, content: "tokens live in the vault service", now: T0 + 1 })
      const c = putObservation(h.db, { id: "obs_r_c", workspace, projectId, sessionId, content: "old token policy was yearly", now: T0 - 10 })
      const refs = new Map([
        ["o1", getObservation(h.db, a.id)!],
        ["o2", getObservation(h.db, b.id)!],
        ["o3", getObservation(h.db, c.id)!],
      ])
      applyReflectorOps(
        h.db,
        `project:${projectId}`,
        refs,
        [
          { op: "condense", refs: ["o1", "o2"], content: `Tokens like ${secret} rotate monthly`, kind: "fact" },
          { op: "supersede", oldRef: "o3", newRef: "o1", reason: `new policy for ${secret}` },
          { op: "append_journey", entry: `Learned about ${secret}`, refs: ["o1"] },
          { op: "propose_promotion", ref: "o2", scope: "workspace", reason: `share ${secret}` },
        ],
        [a.id, b.id, c.id],
        T0 + 10,
      )
      const dump = JSON.stringify([
        h.db.prepare("SELECT content FROM observations").all(),
        h.db.prepare("SELECT data FROM observation_events").all(),
        h.db.prepare("SELECT entry FROM journey_entries").all(),
        h.db.prepare("SELECT reason FROM review_items").all(),
        h.db.prepare("SELECT ops FROM reflections").all(),
      ])
      expect(dump).not.toContain(secret)
      expect(dump).toContain("[REDACTED:github-token]")
    } finally {
      h.close()
    }
  })

  test("a bullet without a usable ref whose text was forgotten drops the whole topic op as forgotten content", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      const a = putObservation(h.db, { workspace, projectId, sessionId, content: "trees can be balanced by rotation" })
      const forgotten = "the therapist appointment is every tuesday at noon"
      const b = putObservation(h.db, { workspace, projectId, sessionId, content: forgotten })
      forgetObservations(h.db, [b.id], { actor: "user", reason: "forget" })
      const refs = new Map([["o1", getObservation(h.db, a.id)!]])
      const v = validateReflectorOps(
        {
          ops: [
            {
              op: "upsert_topic",
              slug: "trees",
              title: "Trees",
              sections: [
                {
                  heading: "Facts",
                  bullets: [
                    { text: forgotten, refs: [" "] },
                    { text: "Trees can be balanced by rotation", refs: ["o1"] },
                  ],
                },
              ],
            },
          ],
        },
        refs,
        h.db,
      )
      expect(v.ops).toEqual([])
      expect(v.dropped).toContain("forgotten content")
      expect(v.dropped).toContain("topic built on stale or forgotten evidence")
    } finally {
      h.close()
    }
  })

  test("the reflector never parents its worker under an excluded or forgotten session", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId, sessionId } = seed(h.db)
      seed(h.db, { sessionId: "ses_excluded", now: T0 + 50 })
      seed(h.db, { sessionId: "ses_forgotten", now: T0 + 60 })
      h.db.prepare("UPDATE sessions SET excluded = 1 WHERE id = 'ses_excluded'").run()
      h.db.prepare("INSERT INTO suppressions(kind, value, reason, created_at) VALUES ('session', 'ses_forgotten', 'session_forget', ?)").run(T0)
      putObservation(h.db, { workspace, projectId, sessionId, content: "a durable fact that triggers reflection" })
      const runner = new FakeRunner()
      runner.enqueue(() => new RunnerError("aborted", "reflection timed out"))
      await reflectScope({ db: h.db, config: h.config, runner, owner: "parent-owner" }, `project:${projectId}`)
      expect(runner.requests[0].parentSessionId).toBe(sessionId)
    } finally {
      h.close()
    }
  })
})
