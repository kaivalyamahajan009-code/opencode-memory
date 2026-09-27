import { redact } from "./redact"
import { estimateTokens, sha256, truncateMiddle } from "./util"

export const SNAPSHOT_VERSION = 1
export const OBSERVER_INPUT_VERSION = 1

/** Minimal structural view of OpenCode v1 SDK messages/parts. */
export type OcMessageInfo = {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  agent?: string
  mode?: string
  modelID?: string
  providerID?: string
  model?: { providerID: string; modelID: string }
  error?: { name?: string; data?: { message?: string } }
  cost?: number
  summary?: unknown
}

export type OcPart = {
  id: string
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  tool?: string
  callID?: string
  state?: {
    status: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    title?: string
    time?: { compacted?: number }
  }
  mime?: string
  filename?: string
  url?: string
  files?: string[]
  name?: string
  prompt?: string
  description?: string
  agent?: string
}

export type OcMessage = { info: OcMessageInfo; parts: OcPart[] }

export const MEMORY_TOOL_PREFIXES = ["memory_", "learning_", "research_", "artifact_register"]

export function isMemoryTool(name?: string): boolean {
  return !!name && MEMORY_TOOL_PREFIXES.some((p) => name.startsWith(p))
}

export type SnapshotPart = {
  id: string
  ord: number
  type: string
  tool?: string
  text: string
  redactions: number
  omitted: number
  flags: string[]
  hash: string
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

function capInput(input: unknown, max = 4000): string {
  let s: string
  try {
    s = JSON.stringify(input ?? {})
  } catch {
    s = String(input)
  }
  return truncateMiddle(s, max).text
}

export type SnapshotOptions = { captureReasoning: boolean; toolOutputMax: number }

/** Retained snapshot: captured text and order, redacted, with explicit omission markers. */
export function snapshotParts(parts: OcPart[], opts: SnapshotOptions): SnapshotPart[] {
  const out: SnapshotPart[] = []
  parts.forEach((part, ord) => {
    const flags: string[] = []
    let text: string | undefined
    let omitted = 0
    switch (part.type) {
      case "text": {
        if (part.ignored) return
        if (part.synthetic) flags.push("synthetic")
        text = part.text ?? ""
        break
      }
      case "reasoning": {
        if (!opts.captureReasoning) {
          text = "[reasoning omitted]"
          flags.push("omitted")
          omitted = (part.text ?? "").length
        } else text = part.text ?? ""
        break
      }
      case "tool": {
        const state = part.state
        const name = part.tool ?? "unknown"
        if (isMemoryTool(name)) {
          flags.push("recall")
          text = `tool=${name} status=${state?.status ?? "?"}\ninput: ${capInput(state?.input, 1000)}\noutput: [memory tool output omitted]`
          break
        }
        const header = `tool=${name} status=${state?.status ?? "?"}${state?.title ? ` title=${state.title}` : ""}`
        const input = `input: ${capInput(state?.input)}`
        let body = ""
        if (state?.status === "completed") {
          const raw = stripAnsi(state.output ?? "")
          const t = truncateMiddle(raw, opts.toolOutputMax)
          omitted += t.omitted
          body = `output:\n${t.text}`
          if (state.time?.compacted) flags.push("compacted")
        } else if (state?.status === "error") {
          body = `error: ${truncateMiddle(stripAnsi(state.error ?? ""), 4000).text}`
        } else return
        text = `${header}\n${input}\n${body}`
        break
      }
      case "file": {
        text = `[file: ${part.filename ?? part.url?.slice(0, 80) ?? "attachment"} ${part.mime ?? ""}]`.trim()
        break
      }
      case "patch": {
        text = `[patch: ${(part.files ?? []).join(", ")}]`
        break
      }
      case "subtask": {
        text = `[subtask agent=${part.agent ?? "?"}] ${part.description ?? ""}\n${part.prompt ?? ""}`
        break
      }
      case "agent": {
        text = `[agent mention: ${part.name ?? "?"}]`
        break
      }
      default:
        return
    }
    const r = redact(stripAnsi(text))
    if (r.count) flags.push("redacted")
    out.push({
      id: part.id,
      ord,
      type: part.type,
      tool: part.tool,
      text: r.text,
      redactions: r.count,
      omitted,
      flags,
      hash: sha256(`${part.type}\u0000${r.text}`),
    })
  })
  return out
}

export type StoredPart = {
  id: string
  message_id: string
  type: string
  tool: string | null
  text: string
  flags: string | null
  suppressed: number
}

export type StoredMessage = {
  id: string
  seq: number
  role: string
  created_at: number
  agent: string | null
}

/** Collapse runs of identical (or digit-normalized identical) lines. */
export function collapseRepeats(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let i = 0
  const norm = (l: string) => l.replace(/\d+/g, "#").trim()
  while (i < lines.length) {
    let j = i + 1
    while (j < lines.length && norm(lines[j]) === norm(lines[i])) j++
    const run = j - i
    if (run >= 3) {
      out.push(lines[i])
      out.push(`[previous line pattern repeated ${run - 1} more times]`)
    } else {
      for (let k = i; k < j; k++) out.push(lines[k])
    }
    i = j
  }
  return out.join("\n")
}

export type DegenerateReport = { degenerate: boolean; reason?: string }

export function detectDegenerate(text: string): DegenerateReport {
  if (!text.trim()) return { degenerate: false }
  const lines = text.split("\n").filter((l) => l.trim())
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
  if (longest > 20_000) return { degenerate: true, reason: "single line exceeds 20k characters" }
  if (lines.length > 50) {
    const unique = new Set(lines.map((l) => l.trim())).size
    if (unique / lines.length < 0.05) return { degenerate: true, reason: "unique line ratio below 5%" }
  }
  return { degenerate: false }
}

export type ObserverInputMessage = {
  ref: string
  id: string
  seq: number
  at: number
  role: string
  text: string
  authoredText?: string
  recallOnly: boolean
  partIds: string[]
  /** Parts whose text appears in the rendered input (observable + already-observed context); excludes suppressed and recall placeholders. */
  visiblePartIds?: string[]
}

export type ObserverInput = {
  text: string
  messages: ObserverInputMessage[]
  tokens: number
  version: number
}

function hardCapLines(text: string, maxLine = 2000): string {
  return text
    .split("\n")
    .map((l) => (l.length > maxLine ? `${l.slice(0, maxLine)} [... line truncated ...]` : l))
    .join("\n")
}

/** Lossy observer input built from snapshots: sanitize first, then validate. */
export function buildObserverInput(
  messages: StoredMessage[],
  parts: StoredPart[],
  opts: { toolOutputMax: number; perMessageMax?: number; focusPartIds?: string[] },
): ObserverInput {
  const byMsg = new Map<string, StoredPart[]>()
  for (const p of parts) {
    const list = byMsg.get(p.message_id) ?? []
    list.push(p)
    byMsg.set(p.message_id, list)
  }
  const perMessageMax = opts.perMessageMax ?? 12_000
  const focus = opts.focusPartIds?.length ? new Set(opts.focusPartIds) : null
  const out: ObserverInputMessage[] = []
  messages.forEach((m, i) => {
    const ps = byMsg.get(m.id) ?? []
    const chunks: string[] = []
    const authored: string[] = []
    let recallParts = 0
    const observableIds: string[] = []
    const visibleIds: string[] = []
    for (const p of ps) {
      const flags = p.flags ? (JSON.parse(p.flags) as string[]) : []
      const inFocus = !focus || focus.has(p.id)
      if (p.suppressed) {
        chunks.push("[forgotten content omitted]")
        continue
      }
      if (!inFocus) {
        chunks.push(`[already observed] ${truncateMiddle(collapseRepeats(p.text), 800).text}`)
        visibleIds.push(p.id)
        continue
      }
      if (flags.includes("recall")) {
        recallParts++
        chunks.push(`[memory recall by ${p.tool ?? "memory tool"}; not independent evidence]`)
        continue
      }
      let t = collapseRepeats(p.text)
      if (p.type === "tool") t = truncateMiddle(t, opts.toolOutputMax, 0.55).text
      const synthetic = flags.includes("synthetic")
      if (synthetic) t = `[synthetic context] ${truncateMiddle(t, 1500).text}`
      else if (m.role === "user" && p.type === "text") authored.push(p.text)
      chunks.push(hardCapLines(t))
      observableIds.push(p.id)
      visibleIds.push(p.id)
    }
    let text = chunks.join("\n")
    if (detectDegenerate(text).degenerate) text = truncateMiddle(collapseRepeats(text), 2000).text
    text = truncateMiddle(text, perMessageMax, 0.6).text
    const focusParts = focus ? ps.filter((p) => focus.has(p.id)) : ps
    out.push({
      ref: `m${i + 1}`,
      id: m.id,
      seq: m.seq,
      at: m.created_at,
      role: m.role,
      text,
      authoredText: authored.join("\n"),
      recallOnly: focusParts.length > 0 && recallParts === focusParts.length,
      partIds: observableIds,
      visiblePartIds: visibleIds,
    })
  })
  const text = out
    .map((m) => {
      const when = new Date(m.at).toISOString()
      return `<message ref="${m.ref}" role="${m.role}" at="${when}">\n${m.text}\n</message>`
    })
    .join("\n")
  return { text, messages: out, tokens: estimateTokens(text), version: OBSERVER_INPUT_VERSION }
}
