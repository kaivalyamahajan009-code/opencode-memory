import type { Database } from "./sqlite"
import type { ObservationRow } from "./observations"
import { readFilterSql, type AccessContext, type ScopeKind } from "./scope"
import { cosine, loadEmbeddings } from "./embeddings"
import { words } from "./util"

export type SearchOptions = {
  query: string
  ctx: AccessContext
  kinds?: string[]
  scopes?: ScopeKind[]
  domain?: string
  limit?: number
  includeHistory?: boolean
  excludeIds?: Set<string>
  now?: number
  queryVector?: Float32Array
  embeddingModel?: string
  /** Extra row predicate applied before ranking and the limit (e.g. injection-only rules). */
  accept?: (row: ObservationRow) => boolean
}

export type SearchHit = { row: ObservationRow; score: number; text: number; vector: number }

const STABLE_KINDS = new Set([
  "preference",
  "learning-preference",
  "personal-fact",
  "goal",
  "decision",
  "prior-knowledge",
  "demonstrated-skill",
  "conclusion",
  "condensed",
])

function ftsQuery(tokens: string[]): string {
  return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ")
}

function scopeFilter(opts: Pick<SearchOptions, "ctx" | "kinds" | "scopes" | "domain" | "includeHistory">): { sql: string; params: any[] } {
  const parts: string[] = []
  const params: any[] = []
  const r = readFilterSql(opts.ctx, "o", { includeSuperseded: opts.includeHistory })
  parts.push(r.sql)
  params.push(...r.params)
  if (opts.kinds?.length) {
    parts.push(`o.kind IN (${opts.kinds.map(() => "?").join(",")})`)
    params.push(...opts.kinds)
  }
  if (opts.scopes?.length) {
    parts.push(`o.scope_kind IN (${opts.scopes.map(() => "?").join(",")})`)
    params.push(...opts.scopes)
  }
  if (opts.domain) {
    parts.push("o.domain = ?")
    params.push(opts.domain)
  }
  return { sql: parts.join(" AND "), params }
}

/** In-process BM25 over a candidate set (fallback when FTS5 is unavailable). */
function jsBm25(rows: ObservationRow[], tokens: string[]): Map<string, number> {
  const k1 = 1.2
  const b = 0.75
  const docs = rows.map((r) => ({ id: r.id, terms: words(r.content) }))
  const avg = docs.reduce((n, d) => n + d.terms.length, 0) / Math.max(1, docs.length)
  const df = new Map<string, number>()
  for (const t of tokens) df.set(t, docs.filter((d) => d.terms.some((w) => w.startsWith(t))).length)
  const out = new Map<string, number>()
  for (const d of docs) {
    let s = 0
    for (const t of tokens) {
      const tf = d.terms.filter((w) => w.startsWith(t)).length
      if (!tf) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.terms.length) / avg)))
    }
    if (s > 0) out.set(d.id, s)
  }
  return out
}

function textCandidates(db: Database, tokens: string[], opts: SearchOptions): Map<string, { row: ObservationRow; raw: number }> {
  const f = scopeFilter(opts)
  const out = new Map<string, { row: ObservationRow; raw: number }>()
  if (!tokens.length) return out
  if (db.hasFts5) {
    try {
      const rows = db
        .prepare(
          `SELECT o.*, bm25(observations_fts) AS _rank FROM observations_fts JOIN observations o ON o.id = observations_fts.observation_id
           WHERE observations_fts MATCH ? AND ${f.sql} ORDER BY _rank LIMIT 300`,
        )
        .all<ObservationRow & { _rank: number }>(ftsQuery(tokens), ...f.params)
      for (const r of rows) out.set(r.id, { row: r, raw: -r._rank })
      return out
    } catch {
      // malformed MATCH expression: use the JS path
    }
  }
  const terms = tokens.slice(0, 8)
  const rows = db
    .prepare(`SELECT o.* FROM observations o WHERE (${terms.map(() => "o.content LIKE ?").join(" OR ")}) AND ${f.sql} ORDER BY o.observed_at DESC LIMIT 600`)
    .all<ObservationRow>(...terms.map((t) => `%${t}%`), ...f.params)
  const scores = jsBm25(rows, tokens)
  for (const r of rows) {
    const s = scores.get(r.id)
    if (s) out.set(r.id, { row: r, raw: s })
  }
  return out
}

function vectorCandidates(db: Database, opts: SearchOptions): Map<string, { row: ObservationRow; sim: number }> {
  const out = new Map<string, { row: ObservationRow; sim: number }>()
  if (!opts.queryVector || !opts.embeddingModel) return out
  const f = scopeFilter(opts)
  const rows = db.prepare(`SELECT o.* FROM observations o WHERE ${f.sql} ORDER BY o.observed_at DESC LIMIT 3000`).all<ObservationRow>(...f.params)
  const vecs = loadEmbeddings(
    db,
    opts.embeddingModel,
    rows.map((r) => r.content_hash),
  )
  for (const r of rows) {
    const v = vecs.get(r.content_hash)
    if (!v) continue
    const sim = cosine(opts.queryVector, v)
    if (sim > 0.25) out.set(r.id, { row: r, sim })
  }
  return out
}

export function freshness(row: Pick<ObservationRow, "kind" | "observed_at" | "event_at" | "pinned">, now: number): number {
  if (row.pinned || STABLE_KINDS.has(row.kind)) return 1
  const age = Math.max(0, now - (row.event_at ?? row.observed_at))
  const halfLife = row.kind === "task-state" || row.kind === "tool-outcome" ? 7 * 86_400_000 : 45 * 86_400_000
  return 0.35 + 0.65 * Math.pow(0.5, age / halfLife)
}

export function rankBoost(row: ObservationRow, ctx: AccessContext, now: number): number {
  let b = 0.1 * row.confidence
  if (row.priority === "high") b += 0.06
  else if (row.priority === "low") b -= 0.03
  if (row.pinned) b += 0.12
  if (ctx.sessionId && row.session_id === ctx.sessionId) b += 0.05
  else if (row.project_id === ctx.projectId) b += 0.03
  if (row.evidence_type === "explicit" || row.evidence_type === "quiz" || row.evidence_type === "source") b += 0.03
  if (row.from_recall) b -= 0.05
  if (row.status === "superseded") b -= 0.2
  return b * freshness(row, now)
}

/** Hybrid search: BM25 (FTS5 or JS) plus optional vectors, filtered by the central scope policy. */
export function searchObservations(db: Database, opts: SearchOptions): SearchHit[] {
  const now = opts.now ?? Date.now()
  const tokens = [...new Set(words(opts.query))].slice(0, 16)
  const text = textCandidates(db, tokens, opts)
  const vec = vectorCandidates(db, opts)
  const maxText = Math.max(0, ...[...text.values()].map((t) => t.raw))
  const hits: SearchHit[] = []
  for (const id of new Set([...text.keys(), ...vec.keys()])) {
    if (opts.excludeIds?.has(id)) continue
    const row = text.get(id)?.row ?? vec.get(id)!.row
    if (opts.accept && !opts.accept(row)) continue
    const t = maxText ? (text.get(id)?.raw ?? 0) / maxText : 0
    const v = vec.get(id)?.sim ?? 0
    const base = vec.size ? 0.6 * t + 0.4 * v : t
    hits.push({ row, score: base * freshness(row, now) + rankBoost(row, opts.ctx, now), text: t, vector: v })
  }
  return hits.sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)).slice(0, opts.limit ?? 20)
}

/** Recent observations readable in a context, newest first, with no query. */
export function readableRecent(db: Database, ctx: AccessContext, opts: { scopes?: ScopeKind[]; kinds?: string[]; limit?: number } = {}) {
  const f = scopeFilter({ ctx, scopes: opts.scopes, kinds: opts.kinds })
  return db
    .prepare(`SELECT o.* FROM observations o WHERE ${f.sql} ORDER BY o.pinned DESC, o.observed_at DESC LIMIT ?`)
    .all<ObservationRow>(...f.params, opts.limit ?? 100)
}
