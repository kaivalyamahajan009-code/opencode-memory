import { afterAll, describe, expect, test } from "bun:test"
import { T0, cleanupAllTempDirs, openHarness, putObservation, seed, userMsg, ingest } from "./helpers"
import { canRead, canRecallSource, type AccessContext } from "../src/scope"
import { getObservation } from "../src/observations"
import { searchObservations, readableRecent } from "../src/retrieval"

afterAll(cleanupAllTempDirs)

describe("scope isolation", () => {
  test("project A cannot read project B's project or session observations", async () => {
    const h = await openHarness()
    try {
      const a = seed(h.db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" })
      const b = seed(h.db, { projectId: "proj_b", workspace: "other", sessionId: "ses_b" })
      const { id: projB } = putObservation(h.db, {
        workspace: b.workspace,
        projectId: b.projectId,
        sessionId: b.sessionId,
        scopeKind: "project",
        content: "secret project B fact about internal APIs",
      })
      const { id: sesB } = putObservation(h.db, {
        workspace: b.workspace,
        projectId: b.projectId,
        sessionId: b.sessionId,
        scopeKind: "session",
        content: "secret session B task state",
      })
      putObservation(h.db, {
        workspace: a.workspace,
        projectId: a.projectId,
        sessionId: a.sessionId,
        scopeKind: "project",
        content: "project A visible fact",
      })
      const ctxA: AccessContext = { projectId: a.projectId, workspace: a.workspace, sessionId: a.sessionId }
      expect(canRead(ctxA, getObservation(h.db, projB)!)).toBe(false)
      expect(canRead(ctxA, getObservation(h.db, sesB)!)).toBe(false)
      const recent = readableRecent(h.db, ctxA)
      expect(recent.every((r) => r.project_id === a.projectId || r.scope_kind === "user")).toBe(true)
      expect(recent.some((r) => r.id === projB || r.id === sesB)).toBe(false)
    } finally {
      h.close()
    }
  })

  test("workspace sharing works only within the same workspace", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" })
      seed(h.db, { projectId: "proj_c", workspace: "learn", sessionId: "ses_c" })
      seed(h.db, { projectId: "proj_b", workspace: "other", sessionId: "ses_b" })
      const { id } = putObservation(h.db, {
        workspace: "learn",
        projectId: "proj_a",
        sessionId: "ses_a",
        scopeKind: "workspace",
        content: "shared learning note about recursion base cases",
      })
      const row = getObservation(h.db, id)!
      expect(canRead({ projectId: "proj_c", workspace: "learn", sessionId: "ses_c" }, row)).toBe(true)
      expect(canRead({ projectId: "proj_b", workspace: "other", sessionId: "ses_b" }, row)).toBe(false)
    } finally {
      h.close()
    }
  })

  test("user scope is visible from every project", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" })
      seed(h.db, { projectId: "proj_b", workspace: "other", sessionId: "ses_b" })
      const { id } = putObservation(h.db, {
        workspace: "learn",
        projectId: null,
        sessionId: null,
        scopeKind: "user",
        content: "User prefers concise answers",
      })
      const row = getObservation(h.db, id)!
      expect(canRead({ projectId: "proj_a", workspace: "learn" }, row)).toBe(true)
      expect(canRead({ projectId: "proj_b", workspace: "other" }, row)).toBe(true)
    } finally {
      h.close()
    }
  })

  test("pending_review is visible only in its own session", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" })
      seed(h.db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a2" })
      const { id } = putObservation(h.db, {
        workspace: "learn",
        projectId: "proj_a",
        sessionId: "ses_a",
        scopeKind: "session",
        status: "pending_review",
        content: "unconfirmed personal fact awaiting review",
        reviewReason: "needs review",
        targetScope: "user",
      })
      const row = getObservation(h.db, id)!
      expect(canRead({ projectId: "proj_a", workspace: "learn", sessionId: "ses_a" }, row)).toBe(true)
      expect(canRead({ projectId: "proj_a", workspace: "learn", sessionId: "ses_a2" }, row)).toBe(false)
      expect(canRead({ projectId: "proj_a", workspace: "learn" }, row)).toBe(false)
    } finally {
      h.close()
    }
  })

  test("engine.recallSource refuses cross-project sources", async () => {
    const h = await openHarness()
    try {
      const a = seed(h.db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" })
      const b = seed(h.db, { projectId: "proj_b", workspace: "other", sessionId: "ses_b" })
      ingest(h.db, b.sessionId, [userMsg("B only source text about a private claim", { id: "bu1", sessionID: b.sessionId })], { now: T0 })
      const part = h.db.prepare("SELECT id FROM source_parts WHERE session_id = ?").get<{ id: string }>(b.sessionId)!
      const { id } = putObservation(h.db, {
        workspace: b.workspace,
        projectId: b.projectId,
        sessionId: b.sessionId,
        scopeKind: "user",
        content: "A user-scoped fact sourced from project B",
        sources: [
          {
            sessionId: b.sessionId,
            startMessageId: "bu1",
            endMessageId: "bu1",
            startSeq: 1,
            endSeq: 1,
            partIds: [part.id],
            transformVersion: 1,
          },
        ],
      })
      const ctxA: AccessContext = { projectId: a.projectId, workspace: a.workspace, sessionId: a.sessionId }
      const row = getObservation(h.db, id)!
      expect(canRead(ctxA, row)).toBe(true)
      expect(canRecallSource(ctxA, { projectId: b.projectId, workspace: b.workspace }, row)).toBe(false)
    } finally {
      h.close()
    }
  })

  test("search results respect scope", async () => {
    const h = await openHarness()
    try {
      seed(h.db, { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" })
      seed(h.db, { projectId: "proj_b", workspace: "other", sessionId: "ses_b" })
      putObservation(h.db, {
        workspace: "learn",
        projectId: "proj_a",
        sessionId: "ses_a",
        scopeKind: "project",
        content: "unique zebra fact for project alpha search",
      })
      putObservation(h.db, {
        workspace: "other",
        projectId: "proj_b",
        sessionId: "ses_b",
        scopeKind: "project",
        content: "unique zebra fact for project beta search",
      })
      const hitsA = searchObservations(h.db, { query: "zebra", ctx: { projectId: "proj_a", workspace: "learn", sessionId: "ses_a" } })
      expect(hitsA.length).toBeGreaterThan(0)
      expect(hitsA.every((h) => h.row.project_id === "proj_a")).toBe(true)
      const hitsB = searchObservations(h.db, { query: "zebra", ctx: { projectId: "proj_b", workspace: "other", sessionId: "ses_b" } })
      expect(hitsB.every((h) => h.row.project_id === "proj_b")).toBe(true)
    } finally {
      h.close()
    }
  })
})
