import "./hermetic"
import { describe, expect, test } from "bun:test"
import { sha256 } from "@opencode-memory/core"
import { parseFork, projectInfo, resolveProjectId, sweepOrphanMemorySessions, toOcMessage, toSessionMeta } from "../src/opencode-adapter"
import { slimWorkerSystem } from "../src/index"
import { OBSERVER_TITLE, REFLECTOR_TITLE } from "../src/runners/opencode-session"

describe("adapter conversions", () => {
  test("shared global project becomes dir hash", () => {
    const dir = "C:\\Users\\me\\proj"
    expect(resolveProjectId({ id: "abc" }, dir)).toBe("abc")
    expect(resolveProjectId({ id: "global" }, dir)).toBe(`dir:${sha256(dir).slice(0, 16)}`)
  })

  test("session meta maps revert and optional fork lineage", () => {
    const plain = toSessionMeta({
      id: "ses_1",
      parentID: "ses_0",
      title: "Hello",
      revert: { messageID: "msg_r" },
    })
    expect(plain).toEqual({
      id: "ses_1",
      parentID: "ses_0",
      title: "Hello",
      revertMessageID: "msg_r",
      fork: undefined,
    })
    const forked = toSessionMeta({
      id: "ses_2",
      title: "Fork",
      metadata: {
        fork: {
          sourceSessionID: "ses_1",
          boundaryMessageID: "msg_b",
          messages: { old: "new" },
          parts: { p1: "p2" },
        },
      },
    })
    expect(forked.fork).toEqual({
      sourceSessionID: "ses_1",
      boundaryMessageID: "msg_b",
      messages: { old: "new" },
      parts: { p1: "p2" },
    })
    expect(parseFork({ sourceSessionID: "x" })).toBeUndefined()
  })

  test("sdk messages become OcMessage", () => {
    const oc = toOcMessage({
      info: {
        id: "m1",
        sessionID: "s1",
        role: "assistant",
        time: { created: 10, completed: 11 },
        mode: "build",
        modelID: "m",
        providerID: "p",
      },
      parts: [
        { id: "p1", type: "text", text: "hi" },
        { id: "p2", type: "tool", tool: "write", state: { status: "completed", output: "ok" } },
      ],
    })
    expect(oc.info.role).toBe("assistant")
    expect(oc.info.agent).toBe("build")
    expect(oc.parts[0].text).toBe("hi")
    expect(oc.parts[1].tool).toBe("write")
  })

  test("orphan sweep deletes only stale, idle runner sessions started by an om-* worker", async () => {
    const now = Date.now()
    const old = now - 60 * 60_000
    const deleted: string[] = []
    const inspected: string[] = []
    const firstAgent: Record<string, string> = {
      s_old: "om-observer",
      s_refl: "om-reflector",
      s_busy: "om-observer",
      s_named: "build",
      s_notes: "build",
      s_prefix: "om-observer",
    }
    const client = {
      session: {
        async list() {
          return {
            data: [
              { id: "s_old", title: "[memory] observer", time: { updated: old } },
              { id: "s_refl", title: "[memory] reflector", time: { updated: old } },
              { id: "s_new", title: "[memory] reflector", time: { updated: now - 1000 } },
              { id: "s_busy", title: "[memory] observer", time: { updated: old } },
              { id: "s_user", title: "My work", time: { updated: old } },
              { id: "s_notes", title: "[memory] design notes", time: { updated: old } },
              { id: "s_prefix", title: "[memory] observer (copy)", time: { updated: old } },
              { id: "s_named", title: "[memory] observer", time: { updated: old } },
              { id: "s_mine", title: "[memory] reflector", time: { updated: old } },
            ],
          }
        },
        async messages({ path }: any) {
          inspected.push(path.id)
          const agent = firstAgent[path.id]
          if (!agent) return { data: [] }
          return {
            data: [
              { info: { id: "m2", role: "assistant", mode: agent, time: { created: 2 } }, parts: [] },
              { info: { id: "m1", role: "user", agent, time: { created: 1 } }, parts: [] },
            ],
          }
        },
        async delete({ path }: any) {
          deleted.push(path.id)
          if (path.id === "s_old") throw new Error("delete failed is tolerated")
          return { data: true }
        },
      },
    } as any
    await sweepOrphanMemorySessions(client, "/tmp", undefined, (id) => id === "s_busy", (id) => id === "s_mine")
    expect(deleted).toEqual(["s_old", "s_refl", "s_mine"])
    expect(inspected).not.toContain("s_notes")
    expect(inspected).not.toContain("s_mine")
    expect(inspected).toContain("s_named")
    const failing = { session: { list: async () => Promise.reject(new Error("offline")), delete: async () => ({}) } } as any
    await sweepOrphanMemorySessions(failing, "/tmp")
  })

  test("runner titles used by the sweep are the ones the runner creates sessions with", () => {
    expect(OBSERVER_TITLE).toBe("[memory] observer")
    expect(REFLECTOR_TITLE).toBe("[memory] reflector")
  })

  test("project config defaults", () => {
    const p = projectInfo("/tmp/no-such-opencode-memory-project", { id: "p1" }, "Demo")
    expect(p.id).toBe("p1")
    expect(p.workspace).toBe("personal-knowledge")
    expect(p.domain).toBe("general")
    expect(p.excluded).toBe(false)
  })

  test("slimWorkerSystem strips host instructions from om-* worker prompts only when both markers exist", () => {
    const system = [
      "OBSERVER PROMPT\nInstructions from: C:/repo/AGENTS.md\nbe nice\nIMPORTANT: The user has requested structured output. Use the tool.",
    ]
    expect(slimWorkerSystem(system)).toBe(true)
    expect(system[0]).toContain("OBSERVER PROMPT")
    expect(system[0]).toContain("IMPORTANT: The user has requested structured output.")
    expect(system[0]).not.toContain("AGENTS.md")
    const untouched = ["OBSERVER PROMPT\nInstructions from: x"]
    expect(slimWorkerSystem(untouched)).toBe(false)
    expect(untouched[0]).toBe("OBSERVER PROMPT\nInstructions from: x")
  })
})
