/** Last-matching-rule semantics matching OpenCode's Permission.evaluate / fromConfig. */

export type PermissionAction = "ask" | "allow" | "deny"
export type PermissionRule = { permission: string; pattern: string; action: PermissionAction }
export type PermissionConfig = Record<string, PermissionAction | Record<string, PermissionAction>>

export function wildcardMatch(str: string, pattern: string): boolean {
  const s = str.replaceAll("\\", "/")
  const p = pattern.replaceAll("\\", "/")
  let escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$").test(s)
}

function isAction(v: unknown): v is PermissionAction {
  return v === "ask" || v === "allow" || v === "deny"
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** String-form permission (e.g. `"allow"`) means `{ "*": that action }`. */
export function asPermissionObject(perm: unknown): PermissionConfig {
  if (isAction(perm)) return { "*": perm }
  if (isObj(perm)) return { ...(perm as PermissionConfig) }
  return {}
}

export function fromConfig(permission: PermissionConfig): PermissionRule[] {
  const ruleset: PermissionRule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    if (value && typeof value === "object") {
      for (const [pattern, action] of Object.entries(value)) {
        if (isAction(action)) ruleset.push({ permission: key, pattern, action })
      }
    }
  }
  return ruleset
}

export function evaluate(permission: string, pattern: string, ruleset: PermissionRule[]): PermissionRule {
  return (
    [...ruleset].findLast((rule) => wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

/** A key other than the bare `*` that matches `memory_forget` (e.g. `memory_forget`, `memory_*`) is the user's own rule. */
function forgetConfigured(perm: PermissionConfig): boolean {
  return Object.keys(perm).some((k) => k !== "*" && wildcardMatch("memory_forget", k))
}

function omTaskConfigured(perm: PermissionConfig): boolean {
  const task = perm.task
  if (!task || typeof task !== "object") return false
  return Object.keys(task).some((k) => k !== "*" && wildcardMatch("om-observer", k))
}

/**
 * Make `key: { pattern: action }` the last rule for `key` without changing how any other
 * pattern evaluates: the block is rebuilt from every rule that applies to `key` (including
 * wildcard keys like `*` that come after it) and moved to the end.
 */
function appendRule(perm: PermissionConfig, key: string, pattern: string, action: PermissionAction) {
  const block: Record<string, PermissionAction> = {}
  for (const r of fromConfig(perm)) {
    if (!wildcardMatch(key, r.permission)) continue
    delete block[r.pattern]
    block[r.pattern] = r.action
  }
  delete block[pattern]
  block[pattern] = action
  delete perm[key]
  perm[key] = block
}

function lastRule(perm: PermissionConfig, permission: string, pattern: string): PermissionRule | undefined {
  return fromConfig(perm).findLast((r) => wildcardMatch(permission, r.permission) && wildcardMatch(pattern, r.pattern))
}

/**
 * Only add the rule where the block would otherwise allow the action: tightening an existing
 * deny would un-hide the tool (OpenCode hides a tool whose last rule is `*: deny`).
 */
function applyForget(perm: PermissionConfig, always: boolean): PermissionConfig {
  const forget = lastRule(perm, "memory_forget", "*")
  if (forget ? forget.action === "allow" : always) perm.memory_forget = "ask"
  return perm
}

const NATIVE_PRIMARY = new Set(["build", "plan"])
const NATIVE_NON_TASK = new Set(["general", "explore", "compaction", "title", "summary"])

/**
 * Agents that can run as a primary (top-level) agent: native build/plan, the configured
 * default agent, and user agents whose mode is `primary` or `all` (OpenCode's default mode
 * for a custom agent is `all`). Hidden native agents, subagents and om-* workers are excluded.
 */
function primaryAgentNames(cfg: { agent?: Record<string, unknown>; default_agent?: unknown }): string[] {
  const names = new Set<string>()
  const consider = (name: string) => {
    if (name.startsWith("om-")) return
    const value = cfg.agent?.[name]
    const agent = isObj(value) ? value : {}
    if (agent.disable === true) return
    const mode = typeof agent.mode === "string" ? agent.mode : undefined
    if (mode) {
      if (mode !== "subagent") names.add(name)
      return
    }
    if (NATIVE_PRIMARY.has(name) || !NATIVE_NON_TASK.has(name)) names.add(name)
  }
  for (const name of NATIVE_PRIMARY) consider(name)
  for (const name of Object.keys(cfg.agent ?? {})) consider(name)
  if (typeof cfg.default_agent === "string" && cfg.default_agent) consider(cfg.default_agent)
  return [...names]
}

/**
 * Default `memory_forget` to ask unless the user configured it, and hide the om-* workers
 * from primary agents' task tool.
 *
 * The om-* deny goes into each primary agent's own block, never the global one: OpenCode
 * merges the global block into every agent, and a subagent that has any `task` rule keeps
 * the task tool (subagent-permissions.ts only adds its default `task: * deny` when the
 * subagent has no task rule at all). A global or agent rule the user wrote for om-* is left
 * in charge, and a block that already denies om-* is not touched.
 */
export function applyMemoryPermissions(cfg: {
  permission?: unknown
  agent?: Record<string, unknown>
  default_agent?: unknown
}): PermissionConfig {
  const perm = asPermissionObject(cfg.permission)
  const forget = !forgetConfigured(perm)
  if (forget) applyForget(perm, true)
  cfg.permission = perm
  for (const [name, agent] of Object.entries(cfg.agent ?? {})) {
    if (!forget || name.startsWith("om-") || !isObj(agent) || agent.permission === undefined) continue
    agent.permission = applyForget(asPermissionObject(agent.permission), false)
  }
  if (omTaskConfigured(perm)) return perm
  const global = fromConfig(perm)
  for (const name of primaryAgentNames(cfg)) {
    cfg.agent = cfg.agent ?? {}
    const existing = cfg.agent[name]
    const agent: Record<string, unknown> = isObj(existing) ? existing : {}
    const block = asPermissionObject(agent.permission)
    if (omTaskConfigured(block)) continue
    if (evaluate("task", "om-observer", [...global, ...fromConfig(block)]).action === "deny") continue
    appendRule(block, "task", "om-*", "deny")
    agent.permission = block
    cfg.agent[name] = agent
  }
  return perm
}

export const HIDDEN_AGENT_PERMISSION = { "*": "deny", StructuredOutput: "allow" } as const

/**
 * Permission block for an om-* worker: deny everything except StructuredOutput, then the
 * user's own deny rules for that agent (in their order). User allows and asks are dropped,
 * so configuration can only narrow a worker, never widen it.
 */
export function workerPermission(user: unknown): PermissionConfig {
  const out: PermissionConfig = { ...HIDDEN_AGENT_PERMISSION }
  for (const [key, value] of Object.entries(asPermissionObject(user))) {
    const denies: Record<string, PermissionAction> =
      value === "deny"
        ? { "*": "deny" }
        : isObj(value)
          ? Object.fromEntries(Object.entries(value).filter(([, a]) => a === "deny") as [string, PermissionAction][])
          : {}
    if (!Object.keys(denies).length) continue
    const prev = out[key]
    out[key] = { ...(typeof prev === "string" ? { "*": prev } : (prev ?? {})), ...denies }
  }
  return out
}
