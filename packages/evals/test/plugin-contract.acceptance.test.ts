import "./hermetic"
import { afterAll, describe, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { restoreCoverage, TOKEN_HEADER, type OcMessage } from "@opencode-memory/core"
import plugin from "../../plugin/src/index"
import { getMemoryService } from "../../plugin/src/service"
import { splicePrunedMessages } from "../../plugin/src/prune-messages"
import {
  T0,
  ScriptedRunner,
  adapter,
  assistantMessage,
  cleanupAll,
  cleanupDir,
  freePort,
  tempDir,
  userMessage,
} from "./fixtures"

afterAll(cleanupAll)

type WireMessage = { info: Record<string, any>; parts: Record<string, any>[] }

function fakeClient(bySession: Map<string, WireMessage[]>) {
  let child = 0
  return {
    session: {
      async create() {
        return { data: { id: `worker-${++child}` } }
      },
      async prompt() {
        return { data: { info: { structured: { observations: [] } }, parts: [] } }
      },
      async abort() {
        return { data: true }
      },
      async delete() {
        return { data: true }
      },
      async messages({ path }: any) {
        return { data: bySession.get(path.id) ?? [] }
      },
      async get({ path }: any) {
        return { data: { id: path.id, title: path.id, time: { created: T0, updated: T0 } } }
      },
      async list() {
        return { data: [] }
      },
    },
    app: { async log() { return { data: true } } },
  }
}

function pluginInput(dir: string, client: ReturnType<typeof fakeClient>) {
  return {
    client,
    project: { id: "project-plugin", worktree: dir, time: { created: T0 } },
    directory: dir,
    worktree: dir,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: undefined,
  }
}

function raw(options: {
  port: number
  path: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json?: any; text: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        agent: false,
        headers: {
          host: `127.0.0.1:${options.port}`,
          ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text })
        })
      },
    )
    req.on("error", reject)
    req.setTimeout(5_000, () => req.destroy(new Error(`HTTP test request timed out: ${options.path}`)))
    if (body) req.write(body)
    req.end()
  })
}

describe("acceptance: plugin hooks and HTTP contract", () => {
  test("keeps injection stable across model switches and compaction, then prunes messages atomically", async () => {
    const dir = tempDir()
    const port = await freePort()
    const source = [userMessage("live", "u-source", "The user prefers a stable cobalt editor theme", T0)] as OcMessage[]
    const wire = new Map<string, WireMessage[]>([
      [
        "live",
        source.map((message) => ({
          info: message.info as Record<string, any>,
          parts: message.parts as Record<string, any>[],
        })),
      ],
    ])
    const hooks = await plugin.server(pluginInput(dir, fakeClient(wire)) as any, {
      dataDir: dir,
      port,
      runner: "fake",
      fakeOutputs: [(request: any) => (request.purpose === "reflect" ? { ops: [] } : { observations: [] })],
    })
    try {
      const service = getMemoryService()!
      const instance = service.engine.adapterForDirectory(dir)!
      service.engine.trackSession(instance, { id: "live" }, T0)
      service.engine.ingest("live", source, { now: T0 })
      const saved = service.engine.remember(service.engine.context(instance.project.id, "live"), {
        content: "The user prefers a stable cobalt editor theme",
        actor: "user",
        scope: "project",
        sessionId: "live",
      })
      if (!saved.ok) throw new Error(saved.error)
      await hooks["chat.message"]?.(
        { sessionID: "live", messageID: "user-turn" } as any,
        { message: { id: "user-turn", sessionID: "live", role: "user" }, parts: [{ type: "text", text: "Use my editor preference" }] } as any,
      )
      const transform = async (model: string) => {
        const output = { system: ["You are a coding assistant."] }
        await hooks["experimental.chat.system.transform"]?.(
          { sessionID: "live", model: { providerID: "fake", id: model } } as any,
          output,
        )
        return output.system.at(-1)!
      }
      const first = await transform("model-a")
      const switched = await transform("model-b")
      expect(switched).toBe(first)
      expect(first).toContain("cobalt editor theme")
      expect(service.engine.edit(saved.id, "The user prefers a stable amber editor theme")).toBe(true)
      const invalidated = await transform("model-b")
      expect(invalidated).not.toBe(first)
      expect(invalidated).toContain("amber editor theme")
      await hooks["chat.params"]?.(
        {
          sessionID: "live",
          agent: "build",
          model: { providerID: "fake", id: "model-b" },
          provider: {},
          message: { id: "user-turn", sessionID: "live", role: "user", time: { created: T0 }, agent: "build" },
        } as any,
        { temperature: 0, topP: 0, topK: 0, options: {} } as any,
      )
      expect(service.engine.latestSnapshot("live")).toMatchObject({ request_key: "user-turn", model: "fake/model-b" })

      await hooks["experimental.session.compacting"]?.({ sessionID: "live" } as any, { context: [], prompt: undefined })
      await hooks["experimental.chat.messages.transform"]?.(
        {} as any,
        { messages: [{ info: { id: "user-turn", role: "user", sessionID: "live" }, parts: [] }] } as any,
      )
      await hooks["experimental.chat.messages.transform"]?.(
        {} as any,
        {
          messages: [
            { info: { id: "user-turn", role: "user", sessionID: "live" }, parts: [] },
            { info: { id: "auto-continue", role: "user", sessionID: "live" }, parts: [] },
          ],
        } as any,
      )
      const afterCompaction = await transform("model-c")
      expect(afterCompaction).toContain("amber editor theme")
      expect(await transform("model-d")).toBe(afterCompaction)

      service.engine.updateConfig(
        { ...service.engine.config, pruning: { enabled: true, keepRecentTurns: 1 } },
        { trusted: true },
      )
      service.engine.trackSession(instance, { id: "prune" }, T0)
      const stored: OcMessage[] = [
        userMessage("prune", "u0", "old request", T0),
        assistantMessage("prune", "a0", "old call", T0 + 1),
        assistantMessage("prune", "t0", "old result", T0 + 2),
        userMessage("prune", "u1", "middle request", T0 + 3),
        assistantMessage("prune", "a1", "middle answer", T0 + 4),
        userMessage("prune", "u2", "latest request", T0 + 5),
      ]
      service.engine.ingest("prune", stored, { now: T0 })
      restoreCoverage(service.engine.db, "prune", 1, 6, T0, "prune-covered")
      const messages = [
        { info: { id: "u0", role: "user", sessionID: "prune" }, parts: [{ type: "text" }] },
        { info: { id: "a0", role: "assistant", sessionID: "prune" }, parts: [{ type: "tool-call", callID: "call-old" }] },
        { info: { id: "t0", role: "assistant", sessionID: "prune" }, parts: [{ type: "tool-result", callID: "call-old" }] },
        { info: { id: "u1", role: "user", sessionID: "prune" }, parts: [{ type: "text" }] },
        { info: { id: "a1", role: "assistant", sessionID: "prune" }, parts: [{ type: "text" }] },
        { info: { id: "u2", role: "user", sessionID: "prune" }, parts: [{ type: "text" }] },
      ]
      await hooks["experimental.chat.messages.transform"]?.({} as any, { messages } as any)
      expect(messages.map((message) => message.info.id)).toEqual(["u2"])

      const half = [
        { info: { id: "u0", role: "user" }, parts: [{ type: "text" }] },
        { info: { id: "a0", role: "assistant" }, parts: [{ type: "tool-call", callID: "paired" }] },
        { info: { id: "t0", role: "assistant" }, parts: [{ type: "tool-result", callID: "paired" }] },
        { info: { id: "u1", role: "user" }, parts: [{ type: "text" }] },
      ]
      splicePrunedMessages(half, new Set(["u0", "t0"]))
      expect(half.map((message) => message.info.id)).toEqual(["u0", "a0", "t0", "u1"])
      expect(half.at(-1)?.info.id).toBe("u1")
    } finally {
      await hooks.dispose?.()
      cleanupDir(dir)
    }
  })

  test("enforces HTTP security and supports global forget, recall cursors, and command polling", async () => {
    const dir = tempDir()
    const otherDir = tempDir()
    const port = await freePort()
    const recallMessages = Array.from({ length: 45 }, (_, index) =>
      userMessage("recall", `r${index + 1}`, `recall line ${index + 1}`, T0 + index),
    )
    const wire = new Map<string, WireMessage[]>([
      [
        "recall",
        recallMessages.map((message) => ({ info: message.info as Record<string, any>, parts: message.parts as Record<string, any>[] })),
      ],
      [
        "command",
        [
          {
            info: userMessage("command", "cmd-u1", "flush this command session", T0).info as Record<string, any>,
            parts: userMessage("command", "cmd-u1", "flush this command session", T0).parts as Record<string, any>[],
          },
        ],
      ],
    ])
    const hooks = await plugin.server(pluginInput(dir, fakeClient(wire)) as any, {
      dataDir: dir,
      port,
      runner: "fake",
      fakeOutputs: [(request: any) => (request.purpose === "reflect" ? { ops: [] } : { observations: [] })],
    })
    try {
      const service = getMemoryService()!
      const instance = service.engine.adapterForDirectory(dir)!
      const token = service.token
      const api = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
        raw({
          port,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: { [TOKEN_HEADER]: token, ...headers },
          body,
        })

      expect((await raw({ port, path: "/api/status" })).status).toBe(401)
      expect((await raw({ port, path: "/api/status", headers: { host: "evil.example", [TOKEN_HEADER]: token } })).status).toBe(403)
      expect((await api("/api/status", undefined, { origin: "https://evil.example" })).status).toBe(403)
      const page = await raw({ port, path: "/app", headers: { origin: "oc://renderer" } })
      expect(page.status).toBe(200)
      expect(String(page.headers["content-security-policy"])).toContain("frame-ancestors 'self' oc://renderer")
      expect(page.text).toContain('name="om-token"')
      expect(page.headers["cache-control"]).toBe("no-store")

      service.engine.trackSession(instance, { id: "recall" }, T0)
      service.engine.ingest("recall", recallMessages, { now: T0 })
      const recall = await api("/api/recall?session=recall&from=1&to=45&context=0")
      expect(recall.status).toBe(200)
      expect(recall.json.data.messages).toHaveLength(40)
      expect(recall.json.data.truncated).toBe(true)
      expect(recall.json.data.nextCursor.fromSeq).toBe(41)
      const cursor = recall.json.data.nextCursor
      const next = await api(`/api/recall?session=${cursor.sessionId}&from=${cursor.fromSeq}&to=${cursor.toSeq}&context=${cursor.context}`)
      expect(next.json.data.messages.map((message: any) => message.seq)).toEqual([41, 42, 43, 44, 45])

      service.engine.trackSession(instance, { id: "forget-http" }, T0)
      const other = adapter({
        runner: new ScriptedRunner(),
        directory: otherDir,
        id: "other",
        projectId: "project-other",
        workspace: "other-workspace",
      })
      service.engine.register(other, T0)
      service.engine.trackSession(other, { id: "forget-other" }, T0)
      const content = "The user keeps a globally forgettable albatross migration ledger"
      const primary = service.engine.remember(service.engine.context(instance.project.id, "forget-http"), {
        content,
        actor: "user",
        scope: "project",
        sessionId: "forget-http",
      })
      const copy = service.engine.remember(service.engine.context("project-other", "forget-other"), {
        content: `${content} in the archive`,
        actor: "user",
        scope: "project",
        sessionId: "forget-other",
      })
      if (!primary.ok || !copy.ok) throw new Error("forget fixture failed")
      const forgotten = await api("/api/forget", {
        ids: [primary.id],
        session: "forget-http",
        reason: "acceptance",
        confirm: true,
      })
      expect(forgotten.status).toBe(200)
      expect(forgotten.json.data.observationIds).toContain(primary.id)
      expect(service.engine.observation(copy.id)?.status).toBe("forgotten")
      expect(
        service.engine.remember(service.engine.context("project-other", "forget-other"), {
          content,
          actor: "user",
          scope: "project",
          sessionId: "forget-other",
        }),
      ).toMatchObject({ ok: false, status: 409 })

      service.engine.trackSession(instance, { id: "command" }, T0)
      const routed = await api("/api/reflect", { scopeKey: `project:${instance.project.id}` })
      expect(routed.status).toBe(200)
      expect(routed.json.data).toMatchObject({ routed: false, state: "running" })
      const commandId = routed.json.data.commandId
      let command: any
      for (let attempt = 0; attempt < 50; attempt++) {
        command = (await api(`/api/commands/${commandId}`)).json.data
        if (command.state === "done" || command.state === "failed") break
        await Bun.sleep(10)
      }
      expect(command).toMatchObject({ state: "done", attempts: 1 })
      expect(["empty", "succeeded"]).toContain(command.result.status)
      service.engine.unregister(other.id)
    } finally {
      await hooks.dispose?.()
      cleanupDir(dir)
      cleanupDir(otherDir)
    }
  }, 30_000)
})
