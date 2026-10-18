import type { MemoryConfig } from "@opencode-memory/core"

/**
 * Tutor agents share one learning workspace across projects. A project's own
 * workspace (default personal-knowledge, or whatever .opencode/memory.json sets)
 * is left alone; only injection and the learning tools read this one.
 */
export const LEARNING_AGENT_DOMAIN = "learning"
export const LEARNING_AGENT_WORKSPACE = "learning"

export function learningAgentOverride(
  config: MemoryConfig,
  agent: string | undefined,
): { domain: string; workspace: string } | undefined {
  if (!agent || !config.inject.learningAgents.includes(agent)) return undefined
  return { domain: LEARNING_AGENT_DOMAIN, workspace: LEARNING_AGENT_WORKSPACE }
}
