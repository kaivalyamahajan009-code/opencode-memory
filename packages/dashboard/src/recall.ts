import type { RecallCursor, RecallMessage, RecallOk, RecallResult, RecallVia } from "./types"

export type RecallRequest = { observation?: string; session?: string; project?: string; from?: number; to?: number; context?: number }

const PAGE_FALLBACK = 40

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined
}

/** Accepts `{ fromSeq, toSeq?, context?, observationId? }` and the older `{ sessionId, fromSeq }`. */
export function parseRecallCursor(raw: unknown): RecallCursor | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const c = raw as Record<string, unknown>
  const fromSeq = num(c.fromSeq)
  if (fromSeq == null) return undefined
  const out: RecallCursor = { fromSeq }
  const toSeq = num(c.toSeq)
  const context = num(c.context)
  const observationId = str(c.observationId)
  const sessionId = str(c.sessionId)
  if (toSeq != null) out.toSeq = toSeq
  if (context != null) out.context = context
  if (observationId) out.observationId = observationId
  if (sessionId) out.sessionId = sessionId
  return out
}

export function hasTruncatedPart(messages: RecallMessage[]): boolean {
  return messages.some((m) => m.parts?.some((p) => p.truncated === true))
}

export function unwrapRecall(data: unknown): RecallResult {
  if (!data || typeof data !== "object") return { ok: false, error: "empty recall" }
  const d = data as Record<string, unknown>
  if (d.ok === false) return { ok: false, error: String(d.error ?? "recall failed") }
  if (typeof d.guarantee === "string" || Array.isArray(d.messages)) {
    const messages = Array.isArray(d.messages) ? (d.messages as RecallMessage[]) : []
    const out: RecallOk = {
      ok: true,
      guarantee: String(d.guarantee ?? "exact recall of retained, redacted source content"),
      sessionId: String(d.sessionId ?? ""),
      fromSeq: Number(d.fromSeq ?? 0),
      toSeq: Number(d.toSeq ?? 0),
      messages,
      cited: Array.isArray(d.cited) ? (d.cited as [number, number][]) : undefined,
    }
    const cursor = parseRecallCursor(d.nextCursor)
    if (d.truncated === true || cursor || hasTruncatedPart(messages)) out.truncated = true
    if (cursor) out.nextCursor = cursor
    return out
  }
  if (d.data) return unwrapRecall(d.data)
  return { ok: false, error: "unexpected recall shape" }
}

function cleanVia(via: RecallVia | undefined): RecallVia {
  const out: RecallVia = {}
  if (via?.session) out.session = via.session
  if (via?.project) out.project = via.project
  return out
}

/**
 * Recall of one observation, read as its own session (pending rows are only readable from there)
 * or its project, so it works whichever project the server would otherwise default to.
 */
export function recallRequestFor(row: { id: string; session_id: string | null; project_id: string | null }, fallbackSession?: string): RecallRequest {
  return { observation: row.id, context: 1, ...cleanVia({ session: row.session_id || fallbackSession, project: row.project_id || undefined }) }
}

/** Remembers the access hints a page was fetched with so the next page is read the same way. */
export function withVia(result: RecallResult, req: RecallRequest): RecallResult {
  if (!result.ok) return result
  const via = cleanVia(req)
  return Object.keys(via).length ? { ...result, via } : result
}

/**
 * The request that fetches the rest of a truncated recall, or undefined when there is no cursor.
 * The cursor's fields go back unchanged; only cursors from older servers (no toSeq/context) get
 * a guessed range and context 0.
 */
export function nextRecallRequest(result: RecallOk): RecallRequest | undefined {
  const c = result.nextCursor
  if (!c) return undefined
  const via = cleanVia(result.via)
  const citedEnd = result.cited?.length ? Math.max(...result.cited.map((r) => r[1])) : undefined
  const to = c.toSeq ?? (citedEnd != null && citedEnd >= c.fromSeq ? citedEnd : c.fromSeq + PAGE_FALLBACK)
  const context = c.context ?? 0
  if (c.observationId) return { observation: c.observationId, from: c.fromSeq, to, context, ...via }
  const session = c.sessionId ?? result.sessionId
  if (!session) return undefined
  return { session, from: c.fromSeq, to, context, ...(via.project ? { project: via.project } : {}) }
}

/**
 * Appends the next page, dropping messages already shown (their per-part flags are kept). When the
 * page adds nothing the cursor is cleared so the view cannot loop on a server that ignores it.
 */
export function mergeRecall(prev: RecallOk, next: RecallOk): { result: RecallOk; added: number } {
  const seen = new Set(prev.messages.map((m) => m.seq))
  const fresh = next.messages.filter((m) => !seen.has(m.seq))
  if (!fresh.length) return { result: { ...prev, nextCursor: undefined }, added: 0 }
  const messages = [...prev.messages, ...fresh].sort((a, b) => a.seq - b.seq)
  return {
    result: {
      ...prev,
      guarantee: next.guarantee || prev.guarantee,
      fromSeq: Math.min(prev.fromSeq, next.fromSeq),
      toSeq: Math.max(prev.toSeq, next.toSeq, messages[messages.length - 1].seq),
      messages,
      truncated: !!next.truncated || !!next.nextCursor || hasTruncatedPart(messages),
      nextCursor: next.nextCursor,
    },
    added: fresh.length,
  }
}
