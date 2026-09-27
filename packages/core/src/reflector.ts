import type { Database } from "./sqlite"
import type { MemoryConfig } from "./config"
import type { ModelRunner } from "./runner"
import type { ObservationRow } from "./observations"
import {
  addSource,
  getObservation,
  getSources,
  isIdSuppressed,
  isSuppressed,
  mayReplaceScope,
  openReview,
  recordEvent,
  ftsIndex,
  storableText,
  suppressionTarget,
  type SuppressionTarget,
} from "./observations"
import { claimJob, finishJob, jobHeld, type JobClaim } from "./jobs"
import { reserveRun, settleRun, usageOfError } from "./cost"
import { applyObservationDomainHooks, isDomainScope, scrubObservationDomain } from "./observer"
import { REFLECTOR_SYSTEM, reflectorPrompt } from "./prompts"
import { REFLECTOR_JSON_SCHEMA, REFLECTOR_OP_SCHEMA, type ReflectorOp } from "./schemas"
import { classifyError, RunnerError } from "./runner"
import { redact } from "./redact"
import { parseTopicBody, regenerateIndexes, upsertTopic } from "./vault"
import { contentHash, estimateTokens, randomId, safeJson, slugify } from "./util"

const MASTERY_ASSERTION = /\b(has|have|had) (fully )?mastered\b|\bmastery (of|achieved|attained)\b|\bis (now )?an expert\b/i

function scopeWhere(key: string): { where: string; id: string } {
  const [kind, id] = key.split(":")
  return {
    where: kind === "workspace" ? "scope_kind IN ('workspace','user') AND workspace = ?" : "scope_kind = 'project' AND project_id = ?",
    id,
  }
}

function scopeRows(db: Database, key: string, since: number, limit: number): ObservationRow[] {
  const s = scopeWhere(key)
  return db
    .prepare(
      `SELECT * FROM observations WHERE ${s.where} AND status = 'active' AND visibility = 'visible' AND kind != 'condensed'
       ORDER BY (updated_at > ?) DESC, observed_at DESC LIMIT ?`,
    )
    .all<ObservationRow>(s.id, since, limit)
}

function lastReflectionAt(db: Database, key: string): number {
  return db.prepare("SELECT COALESCE(MAX(created_at), 0) AS t FROM reflections WHERE scope_key = ? AND status = 'applied'").get<{ t: number }>(key)!.t
}

/** Scopes whose new durable content crossed the reflection thresholds. */
export function dueScopes(db: Database, cfg: MemoryConfig["reflect"], candidates: string[]): string[] {
  return candidates.filter((key) => {
    const s = scopeWhere(key)
    const r = db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(token_est),0) AS t FROM observations WHERE ${s.where} AND status = 'active' AND updated_at > ?`)
      .get<{ n: number; t: number }>(s.id, lastReflectionAt(db, key))!
    return r.n >= cfg.minNewDurable || r.t >= cfg.thresholdTokens
  })
}

export type ValidatedOps = { ops: ReflectorOp[]; dropped: string[] }

function liveRow(row: ObservationRow | undefined): boolean {
  return !!row && row.visibility === "visible" && (row.status === "active" || row.status === "pending_review")
}

function refreshRefs(db: Database, refs: Map<string, ObservationRow>) {
  for (const [k, row] of [...refs.entries()]) {
    const fresh = getObservation(db, row.id)
    if (fresh) refs.set(k, fresh)
    else refs.delete(k)
  }
}

/** Free text the reflector wants stored: redacted, and empty when it matches forgotten content. */
function storable(db: Database, text: string | undefined, key?: string): string {
  return storableText(db, text, key ? suppressionTarget(db, key) : undefined)
}

/**
 * Refs must be in the input and still live; mastery assertions and forgotten content are dropped.
 * A topic op loses all of its text (title, summary, headings) with any stale or forgotten bullet:
 * the rest was written from the same evidence, so the whole op is dropped.
 */
export function validateReflectorOps(raw: unknown, refs: Map<string, ObservationRow>, db: Database, key?: string): ValidatedOps {
  const list = (raw as any)?.ops
  if (!Array.isArray(list)) throw new RunnerError("invalid_output", "reflector output has no ops array")
  const ops: ReflectorOp[] = []
  const dropped: string[] = []
  const target = key ? suppressionTarget(db, key) : undefined
  const sup = (text: string | undefined) => {
    const clean = redact(text ?? "").text
    return !!clean.trim() && isSuppressed(db, clean, target)
  }
  const known = (r: string) => liveRow(refs.get(r.trim()))
  const stale = (aliases: string[]) =>
    aliases.some((r) => {
      const row = refs.get(r.trim())
      return !row || row.status === "forgotten" || !liveRow(row)
    })
  for (const item of list) {
    const p = REFLECTOR_OP_SCHEMA.safeParse(item)
    if (!p.success) {
      dropped.push("schema")
      continue
    }
    const op = p.data
    switch (op.op) {
      case "upsert_topic": {
        let poisoned = sup(op.title) || sup(op.summary)
        const sections = op.sections
          .map((s) => {
            if (sup(s.heading)) poisoned = true
            return {
              heading: s.heading,
              bullets: s.bullets
                .map((b) => ({ text: b.text, refs: b.refs.map((r) => r.trim()) }))
                .filter((b) => {
                  if (sup(b.text)) return (poisoned = true), dropped.push("forgotten content"), false
                  if (!b.refs.length) return dropped.push("bullet without valid refs"), false
                  if (stale(b.refs) || !b.refs.every(known)) return (poisoned = true), dropped.push("stale ref"), false
                  if (MASTERY_ASSERTION.test(b.text)) return dropped.push("mastery assertion"), false
                  return true
                }),
            }
          })
          .filter((s) => s.bullets.length)
        if (poisoned) {
          dropped.push("topic built on stale or forgotten evidence")
          continue
        }
        if (!sections.length) {
          dropped.push("empty topic")
          continue
        }
        ops.push({ ...op, slug: slugify(op.slug) || slugify(op.title), sections })
        break
      }
      case "condense": {
        const r = op.refs.map((x) => x.trim())
        if (r.length < 2 || stale(r) || !r.every(known) || MASTERY_ASSERTION.test(op.content) || sup(op.content)) {
          dropped.push("invalid condense")
          continue
        }
        ops.push({ ...op, refs: r })
        break
      }
      case "supersede":
        if (!known(op.oldRef) || !known(op.newRef) || op.oldRef.trim() === op.newRef.trim()) dropped.push("invalid supersede")
        else ops.push({ ...op, oldRef: op.oldRef.trim(), newRef: op.newRef.trim() })
        break
      case "append_journey": {
        const jrefs = op.refs.map((r) => r.trim())
        if (!jrefs.length || stale(jrefs) || !jrefs.every(known) || MASTERY_ASSERTION.test(op.entry) || sup(op.entry)) dropped.push("invalid journey")
        else ops.push({ ...op, refs: jrefs })
        break
      }
      case "propose_promotion":
        if (!known(op.ref)) dropped.push("invalid promotion")
        else ops.push({ ...op, ref: op.ref.trim() })
        break
    }
  }
  if (list.length && !ops.length && dropped.every((d) => d === "schema")) throw new RunnerError("invalid_output", "all reflector ops malformed")
  return { ops, dropped }
}

export type ApplyResult = { topics: number; condensed: number; superseded: number; journey: number; proposals: number }

export function applyReflectorOps(db: Database, key: string, refs: Map<string, ObservationRow>, ops: ReflectorOp[], inputIds: string[], now = Date.now()): ApplyResult {
  const id = (r: string) => refs.get(r.trim())!.id
  const out: ApplyResult = { topics: 0, condensed: 0, superseded: 0, journey: 0, proposals: 0 }
  for (const op of ops) {
    switch (op.op) {
      case "upsert_topic": {
        const r = upsertTopic(
          db,
          {
            scopeKey: key,
            slug: op.slug,
            title: op.title,
            summary: op.summary ?? "",
            sections: op.sections.map((s) => ({ heading: s.heading, bullets: s.bullets.map((b) => ({ text: b.text, refs: b.refs.map(id) })) })),
            actor: "reflector",
            merge: true,
          },
          now,
        )
        if (r.changed) out.topics++
        break
      }
      case "condense": {
        const rows = op.refs.map((r) => refs.get(r)!)
        const first = rows[0]
        if (rows.some((r) => r.scope_kind !== first.scope_kind || r.workspace !== first.workspace || r.project_id !== first.project_id)) break
        const content = redact(op.content).text
        if (!content.trim() || isSuppressed(db, content, first)) break
        const cid = randomId("obs")
        db.prepare(
          `INSERT INTO observations(id, scope_kind, session_id, project_id, workspace, kind, domain, content, content_hash, event_at, observed_at,
             confidence, evidence_type, priority, status, visibility, payload, token_est, actor, updated_at)
           VALUES (?,?,?,?,?, 'condensed', ?, ?, ?, ?, ?, ?, 'inferred', ?, 'active', 'visible', ?, ?, 'reflector', ?)`,
        ).run(
          cid,
          first.scope_kind,
          null,
          first.project_id,
          first.workspace,
          first.domain,
          content,
          contentHash(content),
          Math.max(...rows.map((r) => r.event_at ?? r.observed_at)),
          now,
          Math.min(...rows.map((r) => r.confidence)),
          rows.some((r) => r.priority === "high") ? "high" : "medium",
          JSON.stringify({ condensedFrom: rows.map((r) => r.id), kind: op.kind }),
          estimateTokens(content),
          now,
        )
        for (const r of rows) {
          for (const s of getSources(db, r.id))
            addSource(db, cid, {
              sessionId: s.session_id,
              startMessageId: s.start_message_id,
              endMessageId: s.end_message_id,
              startSeq: s.start_seq,
              endSeq: s.end_seq,
              partIds: safeJson<string[]>(s.part_ids, []),
              transformVersion: s.transform_version,
            })
          if (r.pinned) continue
          db.prepare("UPDATE observations SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(cid, now, r.id)
          recordEvent(db, r.id, "condensed", "reflector", { into: cid }, now)
        }
        ftsIndex(db, cid, content, "condensed")
        recordEvent(db, cid, "created", "reflector", { condensedFrom: rows.map((r) => r.id) }, now)
        out.condensed++
        break
      }
      case "supersede": {
        const oldRow = refs.get(op.oldRef)!
        const newRow = refs.get(op.newRef)!
        if ((newRow.event_at ?? newRow.observed_at) < (oldRow.event_at ?? oldRow.observed_at) || oldRow.pinned) break
        if (!mayReplaceScope(newRow.scope_kind, oldRow.scope_kind)) break
        db.prepare("UPDATE observations SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(newRow.id, now, oldRow.id)
        recordEvent(db, oldRow.id, "superseded", "reflector", { by: newRow.id, reason: storable(db, op.reason, key) }, now)
        out.superseded++
        break
      }
      case "append_journey": {
        const entry = storable(db, op.entry, key)
        if (!op.refs.length || !entry.trim()) break
        db.prepare("INSERT INTO journey_entries(id, scope_key, at, entry, refs) VALUES (?,?,?,?,?)").run(
          randomId("jr"),
          key,
          now,
          entry,
          JSON.stringify(op.refs.map(id)),
        )
        out.journey++
        break
      }
      case "propose_promotion": {
        const row = refs.get(op.ref)!
        if (op.scope !== "project" || row.project_id) {
          openReview(db, "promotion", row.id, storable(db, op.reason, key) || `proposed for ${op.scope} scope`, { scope: op.scope }, now)
          out.proposals++
        }
        break
      }
    }
  }
  db.prepare("INSERT INTO reflections(id, scope_key, generation, input_ids, ops, status, created_at) VALUES (?,?,?,?,?, 'applied', ?)").run(
    randomId("rf"),
    key,
    db.prepare("SELECT COALESCE(MAX(generation),0) + 1 AS g FROM reflections WHERE scope_key = ?").get<{ g: number }>(key)!.g,
    JSON.stringify(inputIds),
    redact(JSON.stringify(ops)).text,
    now,
  )
  return out
}

/**
 * Approving a promotion proposal moves the observation to the proposed scope. When the row's
 * id or content is forgotten at that scope the promotion is refused: the row stays where it
 * is, a `promotion-refused` event is recorded, the proposal is closed and false is returned.
 */
export function applyPromotion(db: Database, reviewId: string, actor = "user", now = Date.now()): boolean {
  return db.tx(() => {
    const r = db.prepare("SELECT * FROM review_items WHERE id = ? AND kind = 'promotion' AND state = 'open'").get<{ ref_id: string; data: string }>(reviewId)
    if (!r) return false
    const scope = safeJson<{ scope?: string }>(r.data, {}).scope
    if (!scope) return false
    const before = getObservation(db, r.ref_id)
    if (before?.status === "active") {
      const target: SuppressionTarget = { scope_kind: scope, project_id: before.project_id, workspace: before.workspace }
      if (isIdSuppressed(db, before.id, target) || isSuppressed(db, before.content, target)) {
        recordEvent(db, before.id, "promotion-refused", actor, { scope }, now)
        db.prepare("UPDATE review_items SET state = 'rejected', resolved_at = ?, resolved_by = 'system' WHERE id = ?").run(now, reviewId)
        return false
      }
    }
    const moved = db.prepare("UPDATE observations SET scope_kind = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(scope, now, r.ref_id).changes > 0
    recordEvent(db, r.ref_id, "promoted", actor, { scope }, now)
    if (moved && before) {
      const wasShared = isDomainScope(before.scope_kind)
      if (!wasShared && isDomainScope(scope)) applyObservationDomainHooks(db, r.ref_id, now)
      else if (wasShared && !isDomainScope(scope)) scrubObservationDomain(db, r.ref_id, now)
    }
    db.prepare("UPDATE review_items SET state = 'approved', resolved_at = ?, resolved_by = ? WHERE id = ?").run(now, actor, reviewId)
    return true
  })
}

/** Existing topics with their sections, so updates are deliberate. Omitted sections are kept by the merge. */
function describeTopics(db: Database, key: string, maxChars: number): string {
  const rows = db
    .prepare("SELECT slug, title, summary, body FROM topics WHERE scope_key = ? AND state != 'deleted' ORDER BY updated_at DESC")
    .all<{ slug: string; title: string; summary: string | null; body: string }>(key)
  const out: string[] = []
  let used = 0
  for (const t of rows) {
    const parsed = parseTopicBody(t.body)
    const lines = [`- ${t.slug}: ${t.title}${t.summary ? ` — ${t.summary}` : ""}`]
    for (const s of parsed.sections) {
      lines.push(`  ## ${s.heading}`)
      for (const b of s.bullets.slice(0, 8)) lines.push(`    - ${b.text.slice(0, 160)}`)
    }
    const block = lines.join("\n")
    if (used + block.length > maxChars) {
      out.push(`- ${t.slug}: ${t.title}`)
      used += t.slug.length + t.title.length + 4
      continue
    }
    out.push(block)
    used += block.length
  }
  return out.join("\n")
}

export type ReflectDeps = {
  db: Database
  config: MemoryConfig
  runner: ModelRunner
  owner: string
  directory?: string
  signal?: AbortSignal
  log?: (level: "info" | "warn" | "error", msg: string) => void
}

/**
 * Parent for the reflector's worker session: the scope's most recent real session that is
 * live, captured, and not forgotten (a forgotten session is excluded and suppressed).
 */
function parentSessionFor(db: Database, key: string, directory?: string): string | undefined {
  const i = key.indexOf(":")
  const kind = key.slice(0, i)
  const id = key.slice(i + 1)
  if (kind !== "project" && kind !== "workspace") return undefined
  const row = db
    .prepare(
      `SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE ${kind === "project" ? "s.project_id = ?" : "p.workspace = ?"} AND s.internal = 0 AND s.deleted_at IS NULL AND s.excluded = 0
       AND NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.kind = 'session' AND x.value = s.id)
       ORDER BY (p.directory = ?) DESC, COALESCE(s.last_activity_at, s.updated_at) DESC LIMIT 1`,
    )
    .get<{ id: string }>(id, directory ?? "")
  return row?.id
}

export type ReflectOutcome =
  | { status: "busy" | "empty" }
  | { status: "applied"; applied: ApplyResult; dropped: string[] }
  | { status: "failed"; error: string; cls: string }

export async function reflectScope(deps: ReflectDeps, key: string): Promise<ReflectOutcome> {
  const { db, config } = deps
  let claim: JobClaim | undefined
  let opId: string | undefined
  let usage = { cost: 0, inputTokens: 0, outputTokens: 0, model: undefined as string | undefined }
  try {
    claim = claimJob(db, `reflect:${key}`, "reflect", deps.owner, config.runner.timeoutMs + 60_000)
    if (!claim) return { status: "busy" }
    const rows = scopeRows(db, key, lastReflectionAt(db, key), 300)
    if (!rows.length) {
      finishJob(db, claim)
      return { status: "empty" }
    }
    const refs = new Map<string, ObservationRow>()
    const lines = rows.map((r, i) => {
      refs.set(`o${i + 1}`, r)
      return `o${i + 1} [${r.kind} · ${new Date(r.event_at ?? r.observed_at).toISOString().slice(0, 10)} · ${r.evidence_type} · conf ${r.confidence.toFixed(2)}] ${r.content}`
    })
    const topics = describeTopics(db, key, 6000)
    const journey = db
      .prepare("SELECT at, entry FROM journey_entries WHERE scope_key = ? ORDER BY at DESC LIMIT 10")
      .all<{ at: number; entry: string }>(key)
      .map((j) => `- ${new Date(j.at).toISOString().slice(0, 10)} ${j.entry}`)
      .join("\n")
    opId = reserveRun(db, config.cost, { kind: "reflect", refId: key, runner: deps.runner.id })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.runner.timeoutMs)
    timer.unref?.()
    const onAbort = () => controller.abort()
    deps.signal?.addEventListener("abort", onAbort)
    const result = await deps.runner
      .run(
        {
          purpose: "reflect",
          agent: "om-reflector",
          system: REFLECTOR_SYSTEM,
          prompt: reflectorPrompt({ observations: lines.join("\n"), topics, journey }),
          schema: REFLECTOR_JSON_SCHEMA as unknown as Record<string, unknown>,
          parentSessionId: parentSessionFor(db, key, deps.directory),
          directory: deps.directory,
          model: config.reflectorRunner?.model ?? config.runner.model,
        },
        controller.signal,
      )
      .finally(() => {
        clearTimeout(timer)
        deps.signal?.removeEventListener("abort", onAbort)
      })
    usage = { cost: result.cost, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: result.model }
    let validated: ValidatedOps = { ops: [], dropped: [] }
    const applied = db.tx(() => {
      if (!jobHeld(db, claim!)) throw new RunnerError("aborted", "reflection lease lost")
      refreshRefs(db, refs)
      validated = validateReflectorOps(result.output, refs, db, key)
      const r = applyReflectorOps(
        db,
        key,
        refs,
        validated.ops,
        rows.map((x) => x.id),
      )
      const ws = key.startsWith("workspace:")
        ? key.slice("workspace:".length)
        : db.prepare("SELECT workspace FROM projects WHERE id = ?").get<{ workspace: string }>(key.slice("project:".length))?.workspace
      if (ws) regenerateIndexes(db, ws)
      return r
    })
    settleRun(db, opId, { ...result, status: "succeeded" })
    finishJob(db, claim)
    deps.log?.("info", `reflected ${key}: ${JSON.stringify(applied)} dropped ${validated.dropped.length}`)
    return { status: "applied", applied, dropped: validated.dropped }
  } catch (e) {
    const err = classifyError(e)
    if (!usage.cost) usage = usageOfError(e) ?? usage
    try {
      if (opId) settleRun(db, opId, { ...usage, status: "failed", error: err.message, errorClass: err.cls })
      if (claim) finishJob(db, claim, { error: `${err.cls}: ${err.message}`, retryAfterMs: err.retryAfterMs ?? (err.cls === "cost_limit" ? 3_600_000 : 5 * 60_000) })
    } catch (inner) {
      deps.log?.("warn", `reflect ${key} cleanup failed: ${String(inner)}`)
    }
    deps.log?.("warn", `reflect ${key} failed: ${err.message}`)
    return { status: "failed", error: err.message, cls: err.cls }
  }
}
