/** Message shape used by OpenCode's experimental.chat.messages.transform hook. */
export type TransformMessage = { info: { id: string; role: string; sessionID?: string; agent?: string; mode?: string }; parts?: unknown[] }

type CallPart = { type?: string; callID?: string; state?: { status?: string } }

/**
 * Call ids that tie this message to another one. A finished OpenCode `tool` part carries
 * the call and its result (state.output / state.error) together, so it never pairs across
 * messages (providers may even reuse call ids between steps); only a call and result stored
 * as separate parts do.
 */
function callIds(parts: unknown[] | undefined): string[] {
  const ids: string[] = []
  for (const p of parts ?? []) {
    const part = p as CallPart
    if (!part?.callID) continue
    if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) continue
    ids.push(String(part.callID))
  }
  return ids
}

/**
 * Drop prunable messages in place. OpenCode ignores `output.messages = …` reassignment,
 * so the array must be spliced. Messages are dropped whole; never drops the last user
 * message, never keeps one half of a split tool call/result pair, and never leaves the
 * history starting with a non-user message.
 */
export function splicePrunedMessages(messages: TransformMessage[], drop: Set<string>): void {
  if (!messages.length || !drop.size) return
  const lastUser = messages.findLastIndex((m) => m.info.role === "user")
  const keep = messages.map((m, i) => i === lastUser || !drop.has(m.info.id))

  for (let changed = true; changed; ) {
    changed = false
    const keptCalls = new Set(messages.flatMap((m, i) => (keep[i] ? callIds(m.parts) : [])))
    messages.forEach((m, i) => {
      if (keep[i] || !callIds(m.parts).some((id) => keptCalls.has(id))) return
      keep[i] = true
      changed = true
    })
  }

  const first = keep.indexOf(true)
  if (first > 0 && messages[first].info.role !== "user") {
    for (let i = first - 1; i >= 0; i--) {
      if (messages[i].info.role !== "user") continue
      keep[i] = true
      break
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) if (!keep[i]) messages.splice(i, 1)
}
