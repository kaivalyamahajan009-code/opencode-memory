import "./hermetic"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { OcClient, SdkMessage } from "../src/opencode-adapter"

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "om-plugin-"))
}

export function rmDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {}
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address()
      const port = addr && typeof addr === "object" ? addr.port : 0
      s.close((err) => (err ? reject(err) : resolve(port)))
    })
    s.on("error", reject)
  })
}

export const cannedUserText = "I prefer dark mode when writing TypeScript in this project."

export function cannedMessages(sessionID = "ses_smoke"): SdkMessage[] {
  const t = Date.now()
  return [
    {
      info: { id: "msg_user", sessionID, role: "user", time: { created: t } },
      parts: [{ id: "pt_u", type: "text", text: cannedUserText }],
    },
    {
      info: {
        id: "msg_asst",
        sessionID,
        role: "assistant",
        time: { created: t + 1, completed: t + 2 },
        mode: "build",
        modelID: "fake",
        providerID: "fake",
        cost: 0,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: "pt_a", type: "text", text: "Noted. I will use a dark theme." }],
    },
  ]
}

export function fakeClient(messages: SdkMessage[] = cannedMessages()): OcClient {
  return {
    session: {
      async create() {
        return { data: { id: "ses_child" } }
      },
      async prompt() {
        return { data: { info: { structured: { observations: [] } } } }
      },
      async abort() {
        return { data: true }
      },
      async delete() {
        return { data: true }
      },
      async messages() {
        return { data: messages }
      },
      async get({ path }: any) {
        return {
          data: { id: path.id, title: "test", projectID: "proj", directory: "/tmp", version: "1", time: { created: 0, updated: 0 } },
        }
      },
      async list() {
        return { data: [] }
      },
    },
    app: {
      async log() {
        return { data: true }
      },
    },
  }
}

export function fakeInput(dir: string, client: OcClient = fakeClient()): PluginInput {
  return {
    client: client as any,
    project: { id: "proj_test", worktree: dir, time: { created: Date.now() } },
    directory: dir,
    worktree: dir,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: undefined as any,
  }
}

export const fakeObserverOutput = {
  observations: [
    {
      kind: "fact",
      content: "The user prefers dark mode when writing TypeScript",
      confidence: 0.9,
      evidenceType: "explicit",
      priority: "medium",
      sources: { start: "m1", end: "m1" },
      quote: "I prefer dark mode",
      scopeHint: "session",
    },
  ],
  currentTask: "configuring the editor",
  suggestedNext: "apply the dark theme",
}

export function toolCtx(sessionID: string, ask: (input: any) => Promise<void> = async () => {}) {
  return {
    sessionID,
    messageID: "msg_tool",
    agent: "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata() {},
    ask,
  }
}
