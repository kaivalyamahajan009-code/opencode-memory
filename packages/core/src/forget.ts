import type { Database } from "./sqlite"
import {
  bumpMemoryGeneration,
  ftsRemove,
  getObservation,
  getSources,
  isIdSuppressed,
  isSuppressed,
  recordEvent,
  rebuildSuppressionShingles,
  scopeCovers,
  suppressionTarget,
  upsertSuppression,
  type ObservationRow,
  type SuppressionScope,
  type SuppressionTarget,
} from "./observations"
import { cancelOpenChunks } from "./chunks"
import { rebuildConcept } from "./learning"
import { recomputeClaimStatus, releaseResearchSource } from "./research"
import {
  enqueueTopic,
  enqueueVaultDelete,
  forgottenTopicLabel,
  forgottenTopicSlug,
  parseTopicBody,
  regenerateIndexes,
  relPathWithSlug,
  renderTopicBody,
  type TopicSection,
} from "./vault"
import { contentHash, deterministicId, hashedShingles, jaccard, safeJson, shingles, slugify, words } from "./util"
import type { Payload } from "./schemas"
import { sessionRowReadable, type AccessContext, type ObservationScopeRow } from "./scope"

/**
 * sources: purge the retained snapshot parts the observation cites (its listed
 * part ids, or every part in its source range when none are listed).
 * none: keep the retained snapshot (the observation text is still forgotten).
 */
export type SourcePurge = "sources" | "none"

export type ForgetResult = {
  observationIds: string[]
  partsPurged: number
  topicsTouched: string[]
  snapshotsPurged: number
  skipped?: string[]
  /** Sources of a forgotten condensed summary that are current again. */
  reactivated?: string[]
  /** Backups rewritten without the forgotten content (only when the scrub was awaited). */
  backupsScrubbed?: number
  /** Backups that could not be scrubbed yet; retried by the engine's maintenance tick. */
  backupsFailed?: number
  /** Backups still hold the content until the (background or retried) scrub finishes. */
  scrubPending?: boolean
}

export type ForgetOptions = {
  actor: string
  reason: string
  purgeSources?: SourcePurge
  /** Scoped (agent) forget: only rows inside this boundary are touched, and content/observation suppressions carry it. */
  ctx?: AccessContext
  /** Suppression replay: ids come from stored suppressions, not from a user's selection. */
  replay?: boolean
}

export type SuppressionKind = "content" | "part" | "observation" | "session" | "message"

const FORGETTABLE_STATUSES = new Set(["active", "superseded", "expired", "forgotten"])

type BoundaryRow = Pick<ObservationRow, "scope_kind" | "project_id" | "workspace">

function boundaryOf(ctx: Pick<AccessContext, "projectId" | "workspace">): SuppressionScope {
  return { w: ctx.workspace, p: ctx.projectId }
}

/** Inside the caller's sharing boundary, regardless of status (derived copies, predecessors, summaries). */
export function inForgetBoundary(ctx: Pick<AccessContext, "projectId" | "workspace">, row: BoundaryRow): boolean {
  return scopeCovers(boundaryOf(ctx), row)
}

/** What a scoped caller may ask to forget: what canRead allows, plus its superseded/expired history. */
export function inForgetScope(
  ctx: AccessContext,
  row: BoundaryRow & Pick<ObservationScopeRow, "status" | "visibility" | "session_id" | "actor">,
): boolean {
  if (row.visibility !== "visible") return false
  if (row.status === "pending_review") return !!ctx.sessionId && row.session_id === ctx.sessionId
  if (!FORGETTABLE_STATUSES.has(row.status)) return false
  if (row.scope_kind === "session" && !sessionRowReadable(ctx, row)) return false
  return inForgetBoundary(ctx, row)
}

/** SQL equivalent of inForgetScope for alias `o` (non-forgotten candidate statuses only). */
export function forgetScopeSql(ctx: AccessContext, alias = "o"): { sql: string; params: string[] } {
  const a = alias
  const session = ctx.sessionId ?? "\u0000none"
  const sql = `(${a}.visibility = 'visible' AND (
    (${a}.status IN ('active','superseded','expired') AND (
      (${a}.scope_kind = 'project' AND ${a}.project_id = ?)
      OR (${a}.scope_kind = 'session' AND ${a}.project_id = ? AND (${a}.actor != 'agent' OR ${a}.session_id = ?))
      OR (${a}.scope_kind = 'workspace' AND ${a}.workspace = ?)
      OR (${a}.scope_kind = 'user')
    ))
    OR (${a}.status = 'pending_review' AND ${a}.session_id = ?)
  ))`
  return { sql, params: [ctx.projectId, ctx.projectId, session, ctx.workspace, session] }
}

function forgetCode(actor: string, session = false): string {
  if (session) return "session_forget"
  if (actor === "user") return "user_forget"
  if (actor === "suppression") return "suppression_replay"
  return "agent_forget"
}

/** Content and observation suppressions carry the forget's boundary (null = global); the other kinds are always global. */
function addSuppression(db: Database, kind: SuppressionKind, value: string, sh: string[] | null, reason: string, now: number, scope: SuppressionScope[] | null = null) {
  upsertSuppression(db, { kind, value, shingles: sh, reason, createdAt: now, scope: kind === "content" || kind === "observation" ? scope : null })
}

/** Cancel open (incl. quarantined) chunks of a session, optionally only those overlapping a seq range. */
function cancelChunks(db: Database, sessionId: string, range: [number, number] | null, now: number) {
  cancelOpenChunks(db, sessionId, { reason: "forget", ranges: range ? [range] : undefined, now })
}

function cancelChunksForPart(db: Database, partId: string, now: number) {
  const row = db
    .prepare(`SELECT p.session_id, m.seq FROM source_parts p JOIN source_messages m ON m.id = p.message_id WHERE p.id = ?`)
    .get<{ session_id: string; seq: number }>(partId)
  if (row) cancelChunks(db, row.session_id, [row.seq, row.seq], now)
}

/** Only the cited ranges; an observation without sources cancels nothing. */
function cancelChunksForObservation(db: Database, obsId: string, now: number) {
  for (const s of getSources(db, obsId)) cancelChunks(db, s.session_id, [s.start_seq, s.end_seq], now)
}

/** True when a retained part was purged now. A replay (record = false) never records a suppression. */
function purgePart(db: Database, partId: string, now: number, reason: string, record = true): boolean {
  cancelChunksForPart(db, partId, now)
  const live = !!db.prepare("SELECT 1 FROM source_parts WHERE id = ? AND suppressed = 0").get(partId)
  db.prepare("UPDATE source_parts SET text = '[forgotten]', suppressed = 1, redactions = 0 WHERE id = ?").run(partId)
  if (record) addSuppression(db, "part", partId, null, reason, now)
  return live
}

function purgeMessage(db: Database, messageId: string, now: number, reason: string, record = true) {
  if (record) addSuppression(db, "message", messageId, null, reason, now)
  db.prepare("DELETE FROM artifacts WHERE message_id = ?").run(messageId)
}

/**
 * Every fork copy of these parts, in both directions and transitively: parts mapped by the
 * fork lineage, or (when only the message was mapped) the same-hash part of a mapped message.
 * Unknown ids are kept so a fork ingested later still stores them as forgotten.
 */
function forkCopies(db: Database, partIds: string[]): { parts: string[]; messages: string[] } {
  const seen = new Set(partIds)
  const parts = new Set<string>()
  const messages = new Set<string>()
  const partRow = db.prepare("SELECT message_id, hash FROM source_parts WHERE id = ?")
  const linked = db.prepare(
    "SELECT target_id AS id FROM fork_map WHERE source_id = ? AND kind = ? UNION SELECT source_id AS id FROM fork_map WHERE target_id = ? AND kind = ?",
  )
  const sameHash = db.prepare("SELECT id, message_id FROM source_parts WHERE message_id = ? AND hash = ?")
  const queue = [...partIds]
  while (queue.length) {
    const id = queue.pop()!
    const found = linked.all<{ id: string }>(id, "part", id, "part").map((r) => r.id)
    const p = partRow.get<{ message_id: string; hash: string }>(id)
    if (p)
      for (const m of linked.all<{ id: string }>(p.message_id, "message", p.message_id, "message"))
        for (const r of sameHash.all<{ id: string; message_id: string }>(m.id, p.hash)) found.push(r.id)
    for (const c of found) {
      if (seen.has(c)) continue
      seen.add(c)
      parts.add(c)
      queue.push(c)
      const row = partRow.get<{ message_id: string }>(c)
      if (row) messages.add(row.message_id)
    }
  }
  return { parts: [...parts], messages: [...messages] }
}

/** Deterministic: the cited parts (and their fork copies), never a similarity guess. */
function citedParts(db: Database, obsId: string): { parts: string[]; messages: string[] } {
  const parts = new Set<string>()
  const messages = new Set<string>()
  for (const s of getSources(db, obsId)) {
    const listed = safeJson<string[]>(s.part_ids, [])
    const rows = listed.length
      ? db
          .prepare(`SELECT id, message_id FROM source_parts WHERE id IN (${listed.map(() => "?").join(",")})`)
          .all<{ id: string; message_id: string }>(...listed)
      : db
          .prepare(
            `SELECT p.id, p.message_id FROM source_parts p JOIN source_messages m ON m.id = p.message_id
             WHERE m.session_id = ? AND m.seq BETWEEN ? AND ?`,
          )
          .all<{ id: string; message_id: string }>(s.session_id, s.start_seq, s.end_seq)
    for (const r of rows) {
      parts.add(r.id)
      messages.add(r.message_id)
    }
  }
  const copies = forkCopies(db, [...parts])
  for (const p of copies.parts) parts.add(p)
  for (const m of copies.messages) messages.add(m)
  return { parts: [...parts], messages: [...messages] }
}

type ForkCopy = { session: string; parts: string[]; messages: string[]; seqs: Set<number> }

/** Content of a session copied into its forks (and their forks, following the copied ids only). */
function forkDescendants(db: Database, sessionId: string): ForkCopy[] {
  const out: ForkCopy[] = []
  const done = new Set([sessionId])
  const queue: { session: string; ids: Set<string> | null }[] = [{ session: sessionId, ids: null }]
  const partsOf = db.prepare("SELECT id FROM source_parts WHERE message_id = ?")
  const seqOf = db.prepare("SELECT seq FROM source_messages WHERE id = ? AND session_id = ?")
  const partSeq = db.prepare("SELECT m.seq FROM source_parts p JOIN source_messages m ON m.id = p.message_id WHERE p.id = ? AND p.session_id = ?")
  while (queue.length) {
    const { session, ids } = queue.shift()!
    const rows = db
      .prepare("SELECT target_session, source_id, target_id, kind FROM fork_map WHERE source_session = ?")
      .all<{ target_session: string; source_id: string; target_id: string; kind: string }>(session)
    const byTarget = new Map<string, typeof rows>()
    for (const r of rows) {
      if (ids && !ids.has(r.source_id)) continue
      byTarget.set(r.target_session, [...(byTarget.get(r.target_session) ?? []), r])
    }
    for (const [target, maps] of byTarget) {
      if (done.has(target)) continue
      done.add(target)
      const copy: ForkCopy = { session: target, parts: [], messages: [], seqs: new Set() }
      const parts = new Set<string>()
      for (const m of maps) {
        if (m.kind === "message") {
          copy.messages.push(m.target_id)
          const seq = seqOf.get<{ seq: number }>(m.target_id, target)?.seq
          if (seq !== undefined) copy.seqs.add(seq)
          for (const p of partsOf.all<{ id: string }>(m.target_id)) parts.add(p.id)
        } else {
          parts.add(m.target_id)
          const seq = partSeq.get<{ seq: number }>(m.target_id, target)?.seq
          if (seq !== undefined) copy.seqs.add(seq)
        }
      }
      copy.parts = [...parts]
      out.push(copy)
      queue.push({ session: target, ids: new Set([...copy.messages, ...copy.parts]) })
    }
  }
  return out
}

/** Observations every source of which lies in the forgotten session or in content copied from it. */
function copiedObservationIds(db: Database, sessionId: string, copies: ForkCopy[]): string[] {
  if (!copies.length) return []
  const bySession = new Map(copies.map((c) => [c.session, c.seqs]))
  const covered = (s: { session_id: string; start_seq: number; end_seq: number }) => {
    if (s.session_id === sessionId) return true
    const seqs = bySession.get(s.session_id)
    if (!seqs) return false
    for (let q = s.start_seq; q <= s.end_seq; q++) if (!seqs.has(q)) return false
    return true
  }
  const out = new Set<string>()
  for (const c of copies) {
    const rows = db
      .prepare(
        `SELECT DISTINCT o.id FROM observations o JOIN observation_sources s ON s.observation_id = o.id
         WHERE s.session_id = ? AND o.status != 'forgotten'`,
      )
      .all<{ id: string }>(c.session)
    for (const r of rows) if (!out.has(r.id) && getSources(db, r.id).every(covered)) out.add(r.id)
  }
  return [...out]
}

/** Remove derived domain records that were built from a forgotten observation. */
export function scrubDomain(db: Database, o: { id: string; workspace: string; kind: string; content: string; payload: Payload }, now: number) {
  const concepts = db.prepare("SELECT DISTINCT concept_id FROM learning_attempts WHERE observation_id = ?").all<{ concept_id: string }>(o.id)
  db.prepare("DELETE FROM learning_attempts WHERE observation_id = ?").run(o.id)
  const conceptIds = new Set(concepts.map((c) => c.concept_id))
  if (o.payload.concept) conceptIds.add(deterministicId("concept", o.workspace, slugify(o.payload.concept)))
  for (const id of conceptIds) rebuildConcept(db, id)

  const claims = db.prepare("SELECT DISTINCT claim_id FROM claim_evidence WHERE observation_id = ?").all<{ claim_id: string }>(o.id)
  db.prepare("DELETE FROM claim_evidence WHERE observation_id = ?").run(o.id)
  for (const c of claims) recomputeClaimStatus(db, c.claim_id, now)
  const statementHashes = [contentHash(o.content), o.payload.claim ? contentHash(o.payload.claim) : null].filter(Boolean) as string[]
  for (const h of statementHashes)
    db.prepare("DELETE FROM research_claims WHERE workspace = ? AND statement_hash = ? AND id NOT IN (SELECT claim_id FROM claim_evidence)").run(
      o.workspace,
      h,
    )

  releaseResearchSource(db, o.workspace, o.payload, o.id)

  if (o.kind === "artifact" && o.payload.path) db.prepare("DELETE FROM artifacts WHERE path = ?").run(o.payload.path)
}

function workspaceOfScopeKey(db: Database, key: string): string | undefined {
  if (key.startsWith("workspace:")) return key.slice("workspace:".length)
  if (key.startsWith("project:"))
    return db.prepare("SELECT workspace FROM projects WHERE id = ?").get<{ workspace: string }>(key.slice("project:".length))?.workspace
  return undefined
}

/** Token match of ids inside free text (refs lists, journey entries, summaries). */
function lineCites(line: string, ids: Set<string>): boolean {
  if (!ids.size) return false
  for (const tok of line.match(/[A-Za-z0-9_]+/g) ?? []) if (ids.has(tok)) return true
  return false
}

type Checker = (text: string, target?: SuppressionTarget) => boolean

/** Memoized isSuppressed: topic generations repeat the same lines many times. */
function makeChecker(db: Database): Checker {
  const cache = new Map<string, boolean>()
  return (text, target) => {
    const t = text.trim()
    if (!t) return false
    const key = `${target ? `${target.scope_kind}|${target.project_id ?? ""}|${target.workspace}` : "*"}\u0000${t}`
    let hit = cache.get(key)
    if (hit === undefined) {
      hit = isSuppressed(db, t, target)
      cache.set(key, hit)
    }
    return hit
  }
}

/** Text fragments of a rendered vault line worth checking (index links, journey lines, front matter). */
function outboxLineTexts(line: string): string[] {
  const l = line.replace(/^[-#>\s]+/, "").replace(/ — refs: .*$/, "")
  const link = l.match(/^\[(.*?)\]\((.*?)\)(?: — (.*))?$/)
  if (link) return [link[1], link[3] ?? ""]
  const journey = l.match(/^\d{4}-\d{2}-\d{2}: (.*)$/)
  if (journey) return [journey[1]]
  const title = l.match(/^title:\s*(.*)$/)
  if (title) return [safeJson<string>(title[1], title[1])]
  return [l]
}

function outboxTarget(db: Database, row: { rel_path: string; topic_id: string | null }, workspaces: Map<string, string>): SuppressionTarget | undefined {
  if (row.topic_id) {
    const key = db.prepare("SELECT scope_key FROM topics WHERE id = ?").get<{ scope_key: string }>(row.topic_id)?.scope_key
    return key ? suppressionTarget(db, key) : undefined
  }
  const ws = workspaces.get(row.rel_path.split("/")[0] ?? "")
  return ws !== undefined ? { scope_kind: "workspace", project_id: null, workspace: ws } : undefined
}

function scrubOutbox(db: Database, ids: Set<string>, check: Checker) {
  const workspaces = new Map<string, string>()
  for (const r of db.prepare("SELECT DISTINCT workspace FROM projects").all<{ workspace: string }>())
    workspaces.set(slugify(r.workspace) || "workspace", r.workspace)
  const rows = db
    .prepare("SELECT id, rel_path, topic_id, content FROM vault_outbox WHERE content != ''")
    .all<{ id: number; rel_path: string; topic_id: string | null; content: string }>()
  for (const p of rows) {
    const target = outboxTarget(db, p, workspaces)
    const hit = p.content.split("\n").some((l) => lineCites(l, ids) || outboxLineTexts(l).some((t) => check(t, target)))
    if (!hit) continue
    db.prepare(
      "UPDATE vault_outbox SET content = '', hash = '', state = CASE WHEN state IN ('pending','conflict') THEN 'superseded' ELSE state END WHERE id = ?",
    ).run(p.id)
  }
}

type Parsed = ReturnType<typeof parseTopicBody>

function parsedHits(parsed: Parsed, ids: Set<string>, sup: (t: string) => boolean): boolean {
  const dead = (t: string) => lineCites(t, ids) || sup(t)
  return (
    parsed.preamble.some(dead) ||
    parsed.sections.some(
      (s) => sup(s.heading) || s.bullets.some((b) => b.refs.some((r) => ids.has(r)) || dead(b.text)) || (s.extras ?? []).some(dead),
    )
  )
}

function scrubParsed(parsed: Parsed, ids: Set<string>, sup: (t: string) => boolean): { sections: TopicSection[]; preamble: string[] } {
  const dead = (t: string) => lineCites(t, ids) || sup(t)
  const sections = parsed.sections
    .map((s) => ({
      heading: sup(s.heading) ? "Notes" : s.heading,
      bullets: s.bullets.filter((b) => !b.refs.some((r) => ids.has(r)) && !dead(b.text)),
      extras: (s.extras ?? []).filter((e) => !dead(e)),
    }))
    .filter((s) => s.bullets.length || s.extras.length)
  return { sections, preamble: parsed.preamble.filter((l) => !dead(l)) }
}

type TopicScrub = { touched: string[]; rewritten: string[]; injected: string[] }

/**
 * Strip every topic line citing a forgotten observation or matching a suppression
 * (title, summary, headings, bullets, free text), in all generations. Summaries
 * are free text written from those observations, so a touched topic loses its
 * summary; a suppressed title (or an emptied topic) is relabelled everywhere and
 * its file renamed. Only topics whose current body changed are rewritten on disk.
 */
function scrubTopics(db: Database, ids: Set<string>, check: Checker, now: number): TopicScrub {
  const touched = new Set<string>()
  const rewritten = new Set<string>()
  const renamed = new Set<string>()
  const injected: string[] = []
  const topics = db
    .prepare("SELECT id, scope_key, slug, rel_path, title, summary, body FROM topics")
    .all<{ id: string; scope_key: string; slug: string; rel_path: string; title: string; summary: string | null; body: string }>()
  const targets = new Map<string, SuppressionTarget | undefined>()
  for (const t of topics) {
    const target = suppressionTarget(db, t.scope_key)
    targets.set(t.id, target)
    const sup = (x: string) => check(x, target)
    const parsed = parseTopicBody(t.body)
    const titleHit = sup(t.title) || (!!parsed.title && sup(parsed.title)) || sup(t.slug.replace(/-/g, " "))
    const summaryHit =
      (!!parsed.summary && (lineCites(parsed.summary, ids) || sup(parsed.summary))) || (!!t.summary && (lineCites(t.summary, ids) || sup(t.summary)))
    if (!titleHit && !summaryHit && !parsedHits(parsed, ids, sup)) continue
    const { sections, preamble } = scrubParsed(parsed, ids, sup)
    const rename = titleHit || !sections.length
    const title = rename ? forgottenTopicLabel(t.id) : t.title
    const slug = rename ? forgottenTopicSlug(t.id) : t.slug
    const body = sections.length ? renderTopicBody(title, "", sections, preamble) : `# ${title}\n\n_All content in this topic was forgotten._\n`
    const relPath = slug === t.slug ? t.rel_path : relPathWithSlug(t.rel_path, slug)
    if (relPath !== t.rel_path) enqueueVaultDelete(db, t.rel_path, now)
    db.prepare(
      `UPDATE topics SET title = ?, slug = ?, rel_path = ?, summary = '', body = ?, content_hash = ?, approved = 0, updated_at = ? WHERE id = ?`,
    ).run(title, slug, relPath, body, contentHash(body), now, t.id)
    for (const s of [t.summary, parsed.summary]) if (s) injected.push(`Topic "${t.title}": ${s}`, s)
    if (rename) injected.push(`Topic "${t.title}"`)
    touched.add(t.id)
    rewritten.add(t.id)
    if (rename) renamed.add(t.id)
  }
  const gens = db
    .prepare("SELECT topic_id, generation, title, body FROM topic_generations")
    .all<{ topic_id: string; generation: number; title: string; body: string }>()
  for (const g of gens) {
    const target = targets.get(g.topic_id)
    const sup = (x: string) => check(x, target)
    const parsed = parseTopicBody(g.body)
    const relabel = renamed.has(g.topic_id) || sup(g.title) || (!!parsed.title && sup(parsed.title))
    const summaryHit = !!parsed.summary && (rewritten.has(g.topic_id) || lineCites(parsed.summary, ids) || sup(parsed.summary))
    if (!relabel && !summaryHit && !parsedHits(parsed, ids, sup)) continue
    const title = relabel ? forgottenTopicLabel(g.topic_id) : g.title
    const { sections, preamble } = scrubParsed(parsed, ids, sup)
    const body = renderTopicBody(title, "", sections, preamble)
    if (parsed.summary) injected.push(`Topic "${g.title}": ${parsed.summary}`, parsed.summary)
    if (relabel) injected.push(`Topic "${g.title}"`)
    if (body === g.body && title === g.title) continue
    db.prepare("UPDATE topic_generations SET title = ?, body = ?, hash = ? WHERE topic_id = ? AND generation = ?").run(
      title,
      body,
      contentHash(body),
      g.topic_id,
      g.generation,
    )
    touched.add(g.topic_id)
  }
  return { touched: [...touched], rewritten: [...rewritten], injected }
}

function scrubJourney(db: Database, ids: Set<string>, check: Checker): Set<string> {
  const workspaces = new Set<string>()
  const rows = db.prepare("SELECT id, scope_key, entry, refs FROM journey_entries").all<{ id: string; scope_key: string; entry: string; refs: string | null }>()
  for (const j of rows) {
    const refs = safeJson<string[]>(j.refs, [])
    if (!refs.some((r) => ids.has(r)) && !lineCites(j.entry, ids) && !check(j.entry, suppressionTarget(db, j.scope_key))) continue
    db.prepare("DELETE FROM journey_entries WHERE id = ?").run(j.id)
    const ws = workspaceOfScopeKey(db, j.scope_key)
    if (ws) workspaces.add(ws)
  }
  return workspaces
}

/** Injected topic lines carry no observation id; match their text instead. */
function purgeSnapshotsContaining(db: Database, needles: string[]): number {
  let n = 0
  for (const s of new Set(needles.map((x) => x.trim()).filter((x) => x.length >= 12)))
    n += db.prepare("DELETE FROM context_snapshots WHERE instr(block, ?) > 0").run(s).changes
  return n
}

/** Journey, topics (all generations), outbox history, injected topic lines, and vault indexes. */
function scrubDerived(db: Database, ids: Set<string>, now: number): { topicsTouched: string[]; snapshotsPurged: number } {
  const check = makeChecker(db)
  const workspaces = scrubJourney(db, ids, check)
  const topics = scrubTopics(db, ids, check, now)
  scrubOutbox(db, ids, check)
  const snapshotsPurged = purgeSnapshotsContaining(db, topics.injected)
  for (const id of topics.rewritten) {
    enqueueTopic(db, id, now, true)
    const key = db.prepare("SELECT scope_key FROM topics WHERE id = ?").get<{ scope_key: string }>(id)?.scope_key ?? ""
    const ws = workspaceOfScopeKey(db, key)
    if (ws) workspaces.add(ws)
  }
  for (const ws of workspaces) regenerateIndexes(db, ws, now)
  return { topicsTouched: topics.touched, snapshotsPurged }
}

/** FTS5 secure-delete (SQLite >= 3.44, enabled by createFts) removes a deleted row's tokens from the index on delete. */
export function ftsSecureDelete(db: Database): boolean {
  if (!db.hasFts5) return false
  try {
    return Number(db.prepare("SELECT v FROM observations_fts_config WHERE k = 'secure-delete'").get<{ v: unknown }>()?.v) === 1
  } catch {
    return false
  }
}

/**
 * Without secure-delete, FTS5 keeps deleted tokens in segment blobs until a merge; optimize
 * rewrites them away. With it, optimize (O(index) under the write lock) runs only when `always`.
 */
export function ftsOptimize(db: Database, opts: { always?: boolean } = {}) {
  if (!db.hasFts5) return
  if (!opts.always && ftsSecureDelete(db)) return
  try {
    db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')")
  } catch {}
}

function condensedFrom(o: Pick<ObservationRow, "payload">): string[] {
  const list = safeJson<{ condensedFrom?: unknown }>(o.payload, {}).condensedFrom
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []
}

type WalkItem = { id: string; explicit: boolean; boundary?: SuppressionScope }

/**
 * Expansion of a forget request:
 * - predecessors only (supersedes chain backwards); a successor is never forgotten implicitly;
 * - a source forgets the condensed summaries built from it, and their other sources are kept;
 * - an explicitly selected summary forgets its direct sources (one level).
 * Every expanded row must be inside the boundary of a scoped forget. A replay expands
 * nothing: every row the original forget reached carries its own stored suppression.
 */
class ForgetWalk {
  /** summary id -> its sources, for reactivation when the summary goes and they stay. */
  readonly siblings = new Map<string, Set<string>>()
  /** Visited ids and the boundary that admitted them (undefined = global). */
  readonly admitted = new Map<string, SuppressionScope | undefined>()

  constructor(
    private readonly db: Database,
    private readonly opts: ForgetOptions,
  ) {}

  private sourcesOf(summary: ObservationRow): string[] {
    const pointing = this.db.prepare("SELECT id FROM observations WHERE superseded_by = ?").all<{ id: string }>(summary.id)
    return [...condensedFrom(summary), ...pointing.map((r) => r.id)]
  }

  expand(seeds: string[], explicit: boolean): string[] {
    const out: string[] = []
    if (this.opts.replay) {
      for (const id of seeds) {
        if (this.admitted.has(id)) continue
        this.admitted.set(id, undefined)
        out.push(id)
        const o = getObservation(this.db, id)
        if (o?.kind === "condensed") this.siblings.set(o.id, new Set(this.sourcesOf(o)))
      }
      return out
    }
    const scoped = this.opts.ctx ? boundaryOf(this.opts.ctx) : undefined
    const queue: WalkItem[] = seeds.map((id) => ({ id, explicit, boundary: scoped }))
    while (queue.length) {
      const item = queue.shift()!
      if (this.admitted.has(item.id)) continue
      const o = getObservation(this.db, item.id)
      if (!o) {
        this.admitted.set(item.id, item.boundary)
        out.push(item.id)
        continue
      }
      const boundary = item.boundary
      if (boundary && !scopeCovers(boundary, o)) continue
      this.admitted.set(o.id, boundary)
      out.push(o.id)
      const next = (id: string | null, asExplicit = false) => {
        if (id && !this.admitted.has(id)) queue.push({ id, explicit: asExplicit, boundary })
      }
      next(o.supersedes_id)
      const pointing = this.db.prepare("SELECT id FROM observations WHERE superseded_by = ?").all<{ id: string }>(o.id)
      if (o.kind === "condensed") {
        if (item.explicit) for (const s of new Set([...condensedFrom(o), ...pointing.map((p) => p.id)])) next(s)
      } else {
        for (const p of pointing) next(p.id)
      }
      for (const summary of this.summariesOf(o)) {
        const sibs = this.siblings.get(summary.id) ?? new Set<string>()
        for (const s of this.sourcesOf(summary)) if (s !== o.id) sibs.add(s)
        this.siblings.set(summary.id, sibs)
        next(summary.id)
      }
    }
    return out
  }

  private summariesOf(o: ObservationRow): ObservationRow[] {
    const out = new Map<string, ObservationRow>()
    if (o.superseded_by) {
      const s = getObservation(this.db, o.superseded_by)
      if (s?.kind === "condensed") out.set(s.id, s)
    }
    const rows = this.db.prepare("SELECT * FROM observations WHERE kind = 'condensed' AND payload LIKE ?").all<ObservationRow>(`%${o.id}%`)
    for (const r of rows) if (condensedFrom(r).includes(o.id)) out.set(r.id, r)
    out.delete(o.id)
    return [...out.values()]
  }
}

/** Hashes and texts of the content suppressed by the current batch. */
type Fresh = { hashes: Set<string>; texts: string[] }

/** Near-duplicates share most words, so they rank near the top of an OR query over the forgotten words. */
const SWEEP_FTS_LIMIT = 200

function ftsAnyWord(text: string): string {
  return [...new Set(words(text))]
    .slice(0, 32)
    .map((w) => `"${w}"`)
    .join(" OR ")
}

type SweepRow = { id: string; content: string; content_hash: string } & BoundaryRow

/**
 * Candidates for the fresh suppressions without reading every row: same hash (indexed), the
 * best FTS matches of each forgotten text, and rejected rows (not in the FTS index). Without
 * FTS5 every live row is a candidate.
 */
function sweepCandidates(db: Database, fresh: Fresh): SweepRow[] {
  const cols = "id, content, content_hash, scope_kind, project_id, workspace"
  const ids = new Set<string>()
  const hashes = [...fresh.hashes]
  for (let i = 0; i < hashes.length; i += 400) {
    const batch = hashes.slice(i, i + 400)
    for (const r of db
      .prepare(`SELECT id FROM observations WHERE content_hash IN (${batch.map(() => "?").join(",")}) AND status != 'forgotten'`)
      .all<{ id: string }>(...batch))
      ids.add(r.id)
  }
  let scan = !db.hasFts5
  for (const text of scan ? [] : fresh.texts) {
    const q = ftsAnyWord(text)
    if (!q) continue
    try {
      for (const r of db
        .prepare("SELECT observation_id AS id FROM observations_fts WHERE observations_fts MATCH ? ORDER BY rank LIMIT ?")
        .all<{ id: string }>(q, SWEEP_FTS_LIMIT))
        ids.add(r.id)
    } catch {
      scan = true
      break
    }
  }
  if (scan) return db.prepare(`SELECT ${cols} FROM observations WHERE status != 'forgotten'`).all<SweepRow>()
  for (const r of db.prepare("SELECT id FROM observations WHERE status = 'rejected'").all<{ id: string }>()) ids.add(r.id)
  const list = [...ids]
  const out: SweepRow[] = []
  for (let i = 0; i < list.length; i += 400) {
    const batch = list.slice(i, i + 400)
    out.push(
      ...db
        .prepare(`SELECT ${cols} FROM observations WHERE id IN (${batch.map(() => "?").join(",")}) AND status != 'forgotten'`)
        .all<SweepRow>(...batch),
    )
  }
  return out
}

/**
 * Rows the suppressions just added now match (exact copies, earlier edits, near-duplicates),
 * found exactly as a later replay would find them, restricted to the forget's boundary.
 */
function sweepSuppressed(db: Database, opts: ForgetOptions, done: Set<string>, fresh: Fresh): string[] {
  if (!fresh.hashes.size && !fresh.texts.length) return []
  const out: string[] = []
  for (const r of sweepCandidates(db, fresh)) {
    if (done.has(r.id)) continue
    if (opts.ctx && !inForgetBoundary(opts.ctx, r)) continue
    if (isSuppressed(db, r.content, r)) out.push(r.id)
  }
  return out
}

function reactivateSiblings(db: Database, walk: ForgetWalk, done: Set<string>, actor: string, now: number): string[] {
  const out: string[] = []
  for (const [summaryId, sibs] of walk.siblings) {
    if (!done.has(summaryId)) continue
    for (const id of sibs) {
      if (done.has(id)) continue
      const r = getObservation(db, id)
      if (!r || r.status !== "superseded" || r.superseded_by !== summaryId) continue
      if (isIdSuppressed(db, id, r) || isSuppressed(db, r.content, r)) continue
      db.prepare("UPDATE observations SET status = 'active', superseded_by = NULL, updated_at = ? WHERE id = ?").run(now, id)
      recordEvent(db, id, "reactivated", actor, { reason: "condensed summary forgotten" }, now)
      out.push(id)
    }
  }
  return out
}

/**
 * Forget removes content everywhere it was derived to, and records hash-only
 * suppressions so the content is not regenerated by re-observation, reflection,
 * or restore. The lifecycle history remains; the text does not. The set removed
 * here is the set a later suppression replay would remove.
 *
 * A replay (opts.replay) forgets exactly the given rows and records nothing: it never
 * adds or widens a suppression, so it cannot reach past the boundary the forget stored.
 */
export function forgetObservations(db: Database, ids: string[], opts: ForgetOptions, now = Date.now()): ForgetResult {
  const mode = opts.purgeSources ?? "none"
  const code = forgetCode(opts.actor)
  const record = !opts.replay
  return db.tx(() => {
    const result: ForgetResult = { observationIds: [], partsPurged: 0, topicsTouched: [], snapshotsPurged: 0 }
    const walk = new ForgetWalk(db, opts)
    const done = new Set<string>()
    let batch = walk.expand(ids, !opts.replay)
    while (batch.length) {
      const fresh: Fresh = { hashes: new Set(), texts: [] }
      for (const id of batch) {
        done.add(id)
        const boundary = walk.admitted.get(id)
        const scope = boundary ? [boundary] : null
        if (record) addSuppression(db, "observation", id, null, code, now, scope)
        const o = getObservation(db, id)
        if (!o) continue
        cancelChunksForObservation(db, id, now)
        const payload = safeJson<Payload>(o.payload, {})
        const previous = db
          .prepare("SELECT data FROM observation_events WHERE observation_id = ? AND data IS NOT NULL")
          .all<{ data: string }>(id)
          .map((e) => safeJson<{ previousHash?: string }>(e.data, {}).previousHash)
          .filter((h): h is string => typeof h === "string" && !!h)
        if (record) {
          if (o.status !== "forgotten" && o.content && o.content !== "[forgotten]") {
            addSuppression(db, "content", o.content_hash, hashedShingles(o.content), code, now, scope)
            fresh.hashes.add(o.content_hash)
            fresh.texts.push(o.content)
          }
          for (const h of previous) {
            addSuppression(db, "content", h, null, code, now, scope)
            fresh.hashes.add(h)
          }
        }
        if (o.status === "forgotten") continue
        if (mode === "sources") {
          const cited = citedParts(db, id)
          for (const partId of cited.parts) if (purgePart(db, partId, now, code, record)) result.partsPurged++
          for (const messageId of cited.messages) purgeMessage(db, messageId, now, code, record)
        }
        for (const h of new Set([o.content_hash, ...previous]))
          db.prepare(
            "DELETE FROM embeddings WHERE content_hash = ? AND NOT EXISTS (SELECT 1 FROM observations WHERE content_hash = ? AND id != ? AND status != 'forgotten')",
          ).run(h, h, id)
        db.prepare(
          `UPDATE observations SET status = 'forgotten', content = '[forgotten]', content_hash = ?, payload = NULL, subject_key = NULL,
             review_reason = NULL, token_est = 0, pinned = 0, updated_at = ? WHERE id = ?`,
        ).run(`forgotten:${id}`, now, id)
        ftsRemove(db, id)
        scrubDomain(db, { id, workspace: o.workspace, kind: o.kind, content: o.content, payload }, now)
        db.prepare("UPDATE observation_events SET data = NULL WHERE observation_id = ?").run(id)
        recordEvent(db, id, "forgotten", opts.actor, undefined, now)
        db.prepare(
          `UPDATE review_items SET
             state = CASE WHEN state = 'open' THEN 'rejected' ELSE state END,
             reason = 'forgotten',
             data = NULL,
             resolved_at = COALESCE(resolved_at, ?),
             resolved_by = COALESCE(resolved_by, ?)
           WHERE ref_id = ?`,
        ).run(now, opts.actor, id)
        if (o.chunk_id) db.prepare("DELETE FROM session_state WHERE chunk_id = ?").run(o.chunk_id)
        db.prepare("UPDATE reflections SET ops = '[]', status = 'purged' WHERE input_ids LIKE ? OR ops LIKE ?").run(`%${id}%`, `%${id}%`)
        result.snapshotsPurged += db.prepare("DELETE FROM context_snapshots WHERE observation_ids LIKE ? OR block LIKE ?").run(`%${id}%`, `%${id}%`).changes
        result.observationIds.push(id)
      }
      batch = record ? walk.expand(sweepSuppressed(db, opts, done, fresh), false).filter((id) => !done.has(id)) : []
    }
    const reactivated = reactivateSiblings(db, walk, done, opts.actor, now)
    if (reactivated.length) result.reactivated = reactivated
    if (result.observationIds.length) {
      const derived = scrubDerived(db, new Set(result.observationIds), now)
      result.topicsTouched = derived.topicsTouched
      result.snapshotsPurged += derived.snapshotsPurged
      ftsOptimize(db)
    }
    return result
  })
}

/** Match free text the user describes (e.g. "forget my address") against stored observations. */
export function findForgetCandidates(db: Database, text: string, limit = 20, ctx?: AccessContext): { id: string; content: string; score: number }[] {
  const target = shingles(text)
  const needle = text.toLowerCase()
  const scope = ctx ? forgetScopeSql(ctx) : undefined
  const rows = db
    .prepare(
      `SELECT o.id, o.content FROM observations o WHERE o.status IN ('active','pending_review','superseded','expired')
       ${scope ? `AND ${scope.sql}` : ""} ORDER BY o.observed_at DESC LIMIT 5000`,
    )
    .all<{ id: string; content: string }>(...(scope?.params ?? []))
  return rows
    .map((r) => ({ ...r, score: jaccard(target, shingles(r.content)) }))
    .filter((r) => r.score >= 0.2 || r.content.toLowerCase().includes(needle))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

function sessionObservationIds(db: Database, sessionId: string): string[] {
  return db
    .prepare(
      `SELECT o.id FROM observations o WHERE o.status != 'forgotten'
       AND (
         o.session_id = ?
         OR (
           EXISTS (SELECT 1 FROM observation_sources s WHERE s.observation_id = o.id AND s.session_id = ?)
           AND NOT EXISTS (SELECT 1 FROM observation_sources s WHERE s.observation_id = o.id AND s.session_id != ?)
         )
       )`,
    )
    .all<{ id: string }>(sessionId, sessionId, sessionId)
    .map((r) => r.id)
}

/** The session and every fork copy of its content (forks of forks included). A replay records no suppressions. */
function applySessionPurge(db: Database, sessionId: string, actor: string, now: number): ForgetResult {
  const replay = actor === "suppression"
  const code = forgetCode(actor, true)
  bumpMemoryGeneration(db)
  if (!replay) addSuppression(db, "session", sessionId, null, code, now)
  cancelChunks(db, sessionId, null, now)
  const copies = forkDescendants(db, sessionId)
  const ids = [...new Set([...sessionObservationIds(db, sessionId), ...copiedObservationIds(db, sessionId, copies)])]
  const result = forgetObservations(db, ids, { actor, reason: code, purgeSources: "none", replay }, now)
  const parts = db.prepare("SELECT id FROM source_parts WHERE session_id = ? AND suppressed = 0").all<{ id: string }>(sessionId)
  for (const p of parts) if (purgePart(db, p.id, now, code, !replay)) result.partsPurged++
  for (const c of copies) {
    for (const id of c.parts) if (purgePart(db, id, now, code, !replay)) result.partsPurged++
    for (const id of c.messages) purgeMessage(db, id, now, code, !replay)
    for (const seq of c.seqs) cancelChunks(db, c.session, [seq, seq], now)
  }
  db.prepare("DELETE FROM artifacts WHERE session_id = ?").run(sessionId)
  db.prepare("DELETE FROM context_snapshots WHERE session_id = ?").run(sessionId)
  db.prepare("DELETE FROM session_state WHERE session_id = ?").run(sessionId)
  db.prepare("UPDATE sessions SET excluded = 1, title = NULL WHERE id = ?").run(sessionId)
  return result
}

/** Forget an entire session: every observation sourced only from it, its retained snapshot, and its artifacts. */
export function forgetSession(db: Database, sessionId: string, actor: string, now = Date.now()): ForgetResult {
  return db.tx(() => applySessionPurge(db, sessionId, actor, now))
}

function applyMessageSuppressions(db: Database) {
  const ids = db.prepare("SELECT value FROM suppressions WHERE kind = 'message'").all<{ value: string }>()
  for (const r of ids) db.prepare("DELETE FROM artifacts WHERE message_id = ?").run(r.value)
}

function applySessionSuppressions(db: Database, now: number) {
  const ids = db.prepare("SELECT value FROM suppressions WHERE kind = 'session'").all<{ value: string }>()
  for (const r of ids) applySessionPurge(db, r.value, "suppression", now)
}

/** Forgotten rows, plus suppressed ids with no row here (a topic line may still cite them). */
function forgottenIds(db: Database): Set<string> {
  const ids = new Set(db.prepare("SELECT id FROM observations WHERE status = 'forgotten'").all<{ id: string }>().map((r) => r.id))
  for (const r of db
    .prepare("SELECT value FROM suppressions s WHERE kind = 'observation' AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = s.value)")
    .all<{ value: string }>())
    ids.add(r.value)
  return ids
}

/**
 * Re-apply every suppression (after restore or import, and inside backups when scrubbing them).
 * Each suppression acts only inside its own stored boundary (observation ids and content alike);
 * the replay never adds or widens one, so a scoped forget cannot spread to out-of-scope rows.
 */
export function applySuppressions(db: Database, now = Date.now()): { observations: number; parts: number } {
  return db.tx(() => {
    bumpMemoryGeneration(db)
    rebuildSuppressionShingles(db)
    const partIds = db
      .prepare("SELECT value FROM suppressions WHERE kind = 'part'")
      .all<{ value: string }>()
      .map((r) => r.value)
    let parts = 0
    for (const id of partIds)
      parts += db.prepare("UPDATE source_parts SET text = '[forgotten]', suppressed = 1 WHERE id = ? AND suppressed = 0").run(id).changes
    const hit = db
      .prepare("SELECT id, content, scope_kind, project_id, workspace FROM observations WHERE status != 'forgotten'")
      .all<{ id: string; content: string } & BoundaryRow>()
      .filter((r) => isIdSuppressed(db, r.id, r) || isSuppressed(db, r.content, r))
      .map((r) => r.id)
    if (hit.length) forgetObservations(db, hit, { actor: "suppression", reason: "suppression_replay", purgeSources: "none", replay: true }, now)
    applyMessageSuppressions(db)
    applySessionSuppressions(db, now)
    scrubDerived(db, forgottenIds(db), now)
    ftsOptimize(db)
    return { observations: hit.length, parts }
  })
}
