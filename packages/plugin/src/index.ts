import type { Config, Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin"
import {
  getSession,
  isInternalSystem,
  memoryGeneration,
  OBSERVER_SYSTEM,
  prunableMessageIds,
  REFLECTOR_SYSTEM,
  TIMEOUT,
  withTimeout,
  type LogFn,
} from "@opencode-memory/core"
import { LruMap } from "./lru"
import { textFromParts, toSessionMeta, type OcClient } from "./opencode-adapter"
import { applyMemoryPermissions, HIDDEN_AGENT_PERMISSION, workerPermission } from "./permission"
import { splicePrunedMessages } from "./prune-messages"
import { acquireService, eventWatermark, memoFresh, type MemoryPluginOptions } from "./service"
import { compactionNote, createTools } from "./tools"

const ARTIFACT_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "patch"])
const DEBOUNCE_MS = 1500
const LAST_USER_MAX = 4000
const KNOWN_SESSIONS_MAX = 2000
const DEADLINE_COOLDOWN_MS = 10 * 60_000
const INSTRUCTIONS_MARKER = "\nInstructions from: "
const STRUCTURED_OUTPUT_MARKER = "IMPORTANT: The user has requested structured output."

const MEMORY_COMMANDS: Record<string, { template: string; description: string }> = {
  remember: {
    description: "Write an observation into observational memory",
    template: "Use the memory_remember tool to store this in observational memory, then confirm what was stored: $ARGUMENTS",
  },
  recall: {
    description: "Search observational memory and recall exact sources",
    template:
      "Use memory_search to find observations about the following, then memory_recall_source on the most relevant ids to quote the exact retained source: $ARGUMENTS",
  },
  "memory-status": {
    description: "Show observational memory status for this session",
    template: "Call the memory_status tool and summarize the result. $ARGUMENTS",
  },
  "review-due": {
    description: "List learning concepts due for review",
    template: "Call the learning_due_reviews tool and offer to quiz me on the due concepts. $ARGUMENTS",
  },
  claims: {
    description: "List research claims and conflicts",
    template: "Call the research_claims tool, and research_conflicts if there are contested claims, focusing on: $ARGUMENTS",
  },
}

function logger(client: OcClient): LogFn {
  return (level, msg, extra) => {
    const fallback = () => console[level === "debug" ? "log" : level]?.(`[opencode-memory] ${msg}`, extra ?? "")
    try {
      const p = client.app?.log?.({ body: { service: "opencode-memory", level, message: msg, extra } })
      if (p && typeof (p as Promise<unknown>).catch === "function") {
        void (p as Promise<unknown>).catch(fallback)
        return
      }
    } catch {}
    fallback()
  }
}

function agentModel(mem: { runner: { model?: { providerID: string; modelID: string } } }, oc: Config): string | undefined {
  const m = mem.runner.model
  if (m?.providerID && m.modelID) return `${m.providerID}/${m.modelID}`
  if (typeof oc.small_model === "string" && oc.small_model.trim()) return oc.small_model.trim()
  return undefined
}

function mergeHiddenAgent(
  existing: Record<string, unknown> | undefined,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const user = existing && typeof existing === "object" ? existing : {}
  return {
    ...defaults,
    ...user,
    mode: "subagent",
    hidden: true,
    prompt: typeof user.prompt === "string" ? user.prompt : defaults.prompt,
    permission: workerPermission(user.permission),
  }
}

function sessionIdFromEvent(event: { type?: string; properties?: any; data?: any }): string | undefined {
  const p = event.properties ?? event.data ?? {}
  if (typeof p.sessionID === "string") return p.sessionID
  if (p.info?.sessionID) return p.info.sessionID
  if (p.part?.sessionID) return p.part.sessionID
  if (typeof event.type === "string" && event.type.startsWith("session.") && p.info?.id) return p.info.id
  return undefined
}

/**
 * OpenCode always joins project instructions (AGENTS.md etc.), MCP instructions and skills
 * into the om-* worker's system prompt; the workers need none of it. Cut from the first
 * instructions block to the structured-output directive, leaving the prompt untouched
 * when either marker is missing.
 */
export function slimWorkerSystem(system: string[]): boolean {
  const head = system[0]
  if (typeof head !== "string") return false
  const start = head.indexOf(INSTRUCTIONS_MARKER)
  if (start < 0) return false
  const end = head.indexOf(STRUCTURED_OUTPUT_MARKER, start)
  if (end < 0) return false
  system[0] = `${head.slice(0, start)}\n${head.slice(end)}`
  return true
}

async function server(input: PluginInput, options?: MemoryPluginOptions): Promise<Hooks> {
  const log = logger(input.client as OcClient)
  const { state, adapter, release } = await acquireService(input, options as MemoryPluginOptions | undefined, log)
  const { engine } = state
  const tools = createTools(engine, adapter, { lastUser: (id) => state.lastUser.get(id) })
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const knownSessions = new LruMap<string, true>(KNOWN_SESSIONS_MAX)
  const compacting = new Set<string>()
  let disposed = false

  const safe = async (label: string, fn: () => Promise<void> | void) => {
    try {
      await fn()
    } catch (e) {
      log("warn", `${label} failed: ${String(e)}`)
    }
  }

  const syncSoon = (sessionId: string) => {
    if (disposed || engine.isInternal(sessionId)) return
    const prev = timers.get(sessionId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      timers.delete(sessionId)
      if (disposed) return
      engine.sync(adapter, sessionId).catch((e) => log("warn", `sync failed: ${String(e)}`))
    }, DEBOUNCE_MS)
    t.unref?.()
    timers.set(sessionId, t)
  }

  const syncNow = async (sessionId: string) => {
    const prev = timers.get(sessionId)
    if (prev) {
      clearTimeout(prev)
      timers.delete(sessionId)
    }
    if (engine.isInternal(sessionId)) return
    await engine.sync(adapter, sessionId)
  }

  const ensureTracked = async (id: string) => {
    if (knownSessions.get(id)) return
    const meta = await adapter.fetchSession?.(id).catch(() => undefined)
    engine.trackSession(adapter, meta ?? { id })
    knownSessions.set(id, true)
  }

  const forgetSessionState = (id: string) => {
    knownSessions.delete(id)
    state.lastUser.delete(id)
    state.currentUserMessage.delete(id)
    state.injectionMemo.delete(id)
    state.injected.delete(id)
    state.deadlineMisses.delete(id)
    compacting.delete(id)
  }

  return {
    config: async (cfg) => {
      cfg.agent = cfg.agent ?? {}
      const model = agentModel(engine.config, cfg)
      const base = {
        mode: "subagent" as const,
        hidden: true,
        permission: { ...HIDDEN_AGENT_PERMISSION },
        ...(model ? { model } : {}),
      }
      cfg.agent["om-observer"] = mergeHiddenAgent(cfg.agent["om-observer"] as Record<string, unknown> | undefined, {
        ...base,
        description: "Hidden observer that records durable memory from transcripts. Do not invoke.",
        prompt: OBSERVER_SYSTEM,
      }) as any
      cfg.agent["om-reflector"] = mergeHiddenAgent(cfg.agent["om-reflector"] as Record<string, unknown> | undefined, {
        ...base,
        description: "Hidden reflector that consolidates observations into topic notes. Do not invoke.",
        prompt: REFLECTOR_SYSTEM,
      }) as any
      applyMemoryPermissions(cfg as { permission?: unknown; agent?: Record<string, unknown> })
      cfg.command = cfg.command ?? {}
      for (const [name, spec] of Object.entries(MEMORY_COMMANDS)) {
        if (cfg.command[name] === undefined) cfg.command[name] = { ...spec }
      }
    },
    event: async ({ event }) => {
      await safe("event", async () => {
        const type = event.type
        const props = (event as any).properties ?? (event as any).data ?? {}
        if (type === "session.created" || type === "session.updated") {
          const info = props.info
          if (!info?.id) return
          engine.trackSession(adapter, toSessionMeta(info))
          knownSessions.set(info.id, true)
          if (engine.isInternal(info.id)) return
          if (info.revert?.messageID) engine.onRevert(info.id, info.revert.messageID)
          else if (getSession(engine.db, info.id)?.revert_message_id) {
            const messages = await adapter.fetchMessages(info.id)
            engine.onUnrevert(info.id, new Set(messages.map((m) => m.info.id)))
          }
          return
        }
        if (type === "session.deleted") {
          const id = props.info?.id ?? props.sessionID
          if (id) {
            engine.onSessionDeleted(id)
            forgetSessionState(id)
          }
          return
        }
        if (type === "session.idle") {
          const id = sessionIdFromEvent(event)
          if (id) await syncNow(id)
          return
        }
        if (type === "message.updated" || type === "message.part.updated") {
          const id = sessionIdFromEvent(event)
          if (!id || engine.isInternal(id)) return
          await ensureTracked(id)
          if (type === "message.part.updated") {
            const part = props.part
            const done = !part?.time || !!part.time.end
            const text = part?.type === "text" && !part.synthetic && typeof part.text === "string" ? part.text : ""
            const messageId = part?.messageID ?? props.info?.id
            if (done && text && messageId && /```(svg|mermaid|xml)|<svg[\s>]/i.test(text)) {
              engine.captureInlineArtifacts(adapter, id, String(messageId), text)
            }
          }
          syncSoon(id)
        }
      })
    },
    "chat.message": async (incoming, output) => {
      await safe("chat.message", async () => {
        const id = incoming.sessionID
        if (!id || engine.isInternal(id)) return
        const text = textFromParts(output.parts as any) || (output.message as any)?.content || ""
        if (text) state.lastUser.set(id, text.slice(0, LAST_USER_MAX))
        const messageID = incoming.messageID || (output.message as any)?.id
        if (typeof messageID === "string" && messageID) state.currentUserMessage.set(id, messageID)
        if (!knownSessions.get(id)) {
          engine.trackSession(adapter, { id })
          knownSessions.set(id, true)
        }
      })
    },
    "experimental.chat.system.transform": async (incoming, output) => {
      await safe("system.transform", async () => {
        const id = incoming.sessionID
        if (!id) return
        if (engine.isInternal(id)) {
          slimWorkerSystem(output.system)
          return
        }
        if (isInternalSystem(output.system)) return
        const messageID = state.currentUserMessage.get(id)
        const memo = state.injectionMemo.get(id)
        if (messageID && memo?.messageID === messageID && memoFresh(engine, memo)) {
          if (memo.block) {
            output.system.push(memo.block)
            state.injected.set(id, messageID)
          } else state.injected.delete(id)
          return
        }
        state.injected.delete(id)
        const now = Date.now()
        const misses = state.deadlineMisses.get(id)
        if (misses && misses.until > now) return
        const deadline = engine.config.inject.deadlineMs
        const generation = memoryGeneration(engine.db)
        const events = eventWatermark(engine.db)
        const result = await withTimeout(engine.buildInjection(id, state.lastUser.get(id), messageID), deadline)
        if (result === TIMEOUT) {
          const count = (misses && !misses.until ? misses.misses : 0) + 1
          if (count >= 2) {
            state.deadlineMisses.set(id, { misses: count, until: now + DEADLINE_COOLDOWN_MS })
            log("warn", `memory injection for ${id} exceeded ${deadline}ms twice in a row; skipping injection for ${DEADLINE_COOLDOWN_MS / 60_000} min`)
          } else {
            state.deadlineMisses.set(id, { misses: count, until: 0 })
            log("warn", `memory injection for ${id} exceeded ${deadline}ms; sent without memory`)
          }
          if (messageID) state.injectionMemo.set(id, { messageID, block: "", ids: [], generation, events })
          return
        }
        state.deadlineMisses.delete(id)
        const block = result?.block ?? ""
        if (messageID) state.injectionMemo.set(id, { messageID, block, ids: result?.ids ?? [], generation, events })
        if (!block) return
        output.system.push(block)
        if (messageID) state.injected.set(id, messageID)
      })
    },
    "chat.params": async (incoming) => {
      await safe("chat.params", async () => {
        const id = incoming.sessionID
        const requestKey = incoming.message?.id
        if (!id || !requestKey || engine.isInternal(id)) return
        const model = incoming.model
        const ref = model?.providerID && model?.id ? `${model.providerID}/${model.id}` : undefined
        const current = state.currentUserMessage.get(id)
        if (current !== requestKey) {
          // The block just sent was built (and is pending in core) under `current`: re-key it to
          // the id chat.params reports and commit it under that id, and re-key the memo so the
          // rest of this turn reuses it instead of rebuilding mid-turn.
          const sent = !!current && state.injected.get(id) === current
          if (sent) engine.commitInjection(id, engine.rekeyInjection(id, current, requestKey) ? requestKey : current, incoming.agent, ref)
          state.currentUserMessage.set(id, requestKey)
          const memo = state.injectionMemo.get(id)
          if (current && memo?.messageID === current) state.injectionMemo.set(id, { ...memo, messageID: requestKey })
          if (sent) state.injected.set(id, requestKey)
          return
        }
        if (state.injected.get(id) !== requestKey) return
        engine.commitInjection(id, requestKey, incoming.agent, ref)
      })
    },
    "experimental.session.compacting": async (incoming, output) => {
      compacting.add(incoming.sessionID)
      await safe("compacting", () => {
        const note = compactionNote(engine, incoming.sessionID)
        if (note) output.context.push(note)
      })
    },
    "tool.execute.after": async (incoming) => {
      await safe("tool.after", () => {
        if (!ARTIFACT_TOOLS.has(incoming.tool)) return
        if (engine.isInternal(incoming.sessionID)) return
        engine.captureToolArtifacts(adapter, incoming.sessionID, incoming.tool, incoming.args)
      })
    },
    "experimental.chat.messages.transform": async (_incoming, output) => {
      await safe("messages.transform", () => {
        const messages = output.messages
        const sessionID = messages[0]?.info.sessionID
        if (sessionID && compacting.has(sessionID)) {
          compacting.delete(sessionID)
          return
        }
        if (!sessionID || engine.isInternal(sessionID)) return
        // Runs before system.transform on every step, including turns that never fire
        // chat.message (the auto-continue prompt after compaction).
        const lastUser = messages.findLast((m) => m.info.role === "user")?.info.id
        if (lastUser) state.currentUserMessage.set(sessionID, lastUser)
        if (!engine.config.pruning.enabled) return
        const drop = prunableMessageIds(
          engine.db,
          sessionID,
          messages as { info: { id: string; role: string; sessionID?: string }; parts: unknown[] }[],
          engine.config.pruning.keepRecentTurns,
        )
        if (!drop.size) return
        splicePrunedMessages(messages as any, drop)
      })
    },
    tool: tools,
    dispose: async () => {
      disposed = true
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      await release()
    },
  }
}

const plugin = { id: "opencode-memory", server } as PluginModule
export default plugin
export { server, createTools }
export { createAdapter } from "./opencode-adapter"
export { applyMemoryPermissions, evaluate, fromConfig } from "./permission"
export type { MemoryPluginOptions }
