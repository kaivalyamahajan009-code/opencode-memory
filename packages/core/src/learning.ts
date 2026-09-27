import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs"
import type { Database } from "./sqlite"
import type { Payload } from "./schemas"
import { deterministicId, slugify } from "./util"

const scheduler = fsrs({ enable_fuzz: false })

function loadCard(json: string): Card {
  const raw = JSON.parse(json)
  return { ...raw, due: new Date(raw.due), last_review: raw.last_review ? new Date(raw.last_review) : undefined }
}

export function upsertConcept(db: Database, workspace: string, name: string, now = Date.now()): string {
  const slug = slugify(name)
  const id = deterministicId("concept", workspace, slug)
  db.prepare("INSERT OR IGNORE INTO learning_concepts(id, workspace, slug, name, created_at) VALUES (?,?,?,?,?)").run(
    id,
    workspace,
    slug,
    name.slice(0, 200),
    now,
  )
  return id
}

export type AttemptInput = {
  workspace: string
  observationId: string
  sessionId?: string | null
  kind: "quiz-attempt" | "retention-check" | "demonstrated-skill"
  payload: Payload
  at: number
  fromRecall: boolean
}

/**
 * FSRS schedules recall practice only. Independence and hints are recorded
 * separately and feed the mastery evidence model, not the scheduler grade alone.
 */
export function recordAttempt(db: Database, input: AttemptInput): string | undefined {
  if (input.fromRecall) return undefined
  const conceptName = input.payload.concept?.trim()
  if (!conceptName) return undefined
  const conceptId = upsertConcept(db, input.workspace, conceptName, input.at)
  const hints = Math.max(0, Number(input.payload.hints ?? 0))
  const independent = input.payload.independent === true && hints === 0
  const evaluation = input.payload.evaluation ?? (input.kind === "demonstrated-skill" ? "correct" : "partial")
  const id = deterministicId("att", input.observationId)
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO learning_attempts(id, concept_id, observation_id, session_id, question, answer, evaluation, hints, independent, kind, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    conceptId,
    input.observationId,
    input.sessionId ?? null,
    input.payload.question ?? null,
    input.payload.answer ?? null,
    evaluation,
    hints,
    independent ? 1 : 0,
    input.kind,
    input.at,
  ).changes
  if (!inserted) return id
  const row = db.prepare("SELECT card, reps, lapses FROM review_cards WHERE concept_id = ?").get<{ card: string; reps: number; lapses: number }>(conceptId)
  const card = row ? loadCard(row.card) : createEmptyCard(new Date(input.at))
  saveCard(db, conceptId, scheduler.next(card, new Date(input.at), gradeFor(evaluation, independent)).card, input.at)
  return id
}

function gradeFor(evaluation: string, independent: boolean): Grade {
  return evaluation === "incorrect" ? Rating.Again : evaluation === "partial" || !independent ? Rating.Hard : Rating.Good
}

function saveCard(db: Database, conceptId: string, card: Card, at: number) {
  db.prepare(
    `INSERT INTO review_cards(concept_id, card, due_at, last_review_at, reps, lapses) VALUES (?,?,?,?,?,?)
     ON CONFLICT(concept_id) DO UPDATE SET card = excluded.card, due_at = excluded.due_at, last_review_at = excluded.last_review_at,
       reps = excluded.reps, lapses = excluded.lapses`,
  ).run(conceptId, JSON.stringify(card), card.due.getTime(), at, card.reps, card.lapses)
}

/**
 * Replay the remaining attempts from an empty card (after attempts were removed by forget).
 * A concept with no attempts and no referencing observations is deleted entirely.
 */
export function rebuildConcept(db: Database, conceptId: string): "rebuilt" | "deleted" | "missing" {
  const c = db.prepare("SELECT workspace, name FROM learning_concepts WHERE id = ?").get<{ workspace: string; name: string }>(conceptId)
  if (!c) return "missing"
  const attempts = db
    .prepare("SELECT evaluation, independent, at FROM learning_attempts WHERE concept_id = ? ORDER BY at")
    .all<{ evaluation: string; independent: number; at: number }>(conceptId)
  if (!attempts.length) {
    db.prepare("DELETE FROM review_cards WHERE concept_id = ?").run(conceptId)
    const referenced = db
      .prepare(
        `SELECT 1 FROM observations WHERE workspace = ? AND status NOT IN ('forgotten','rejected') AND scope_kind IN ('workspace','user')
         AND json_extract(payload, '$.concept') = ? COLLATE NOCASE LIMIT 1`,
      )
      .get(c.workspace, c.name)
    if (referenced) return "rebuilt"
    db.prepare("DELETE FROM learning_concepts WHERE id = ?").run(conceptId)
    return "deleted"
  }
  let card = createEmptyCard(new Date(attempts[0].at))
  for (const a of attempts) card = scheduler.next(card, new Date(a.at), gradeFor(a.evaluation, !!a.independent)).card
  saveCard(db, conceptId, card, attempts[attempts.length - 1].at)
  return "rebuilt"
}

export type MasteryLevel = "introduced" | "practicing" | "demonstrated" | "retained" | "needs-retention-check"

export type ConceptState = {
  id: string
  name: string
  slug: string
  level: MasteryLevel
  attempts: number
  independentCorrect: number
  assisted: number
  incorrect: number
  distinctDays: number
  openMisconceptions: number
  lastIndependentAt: number | null
  dueAt: number | null
  approvedMastery: boolean
}

const DAY = 86_400_000

/** Evidence-based mastery: independent correct answers spread over time, decaying without retention checks. */
export function conceptState(db: Database, conceptId: string, now = Date.now()): ConceptState | undefined {
  const c = db.prepare("SELECT * FROM learning_concepts WHERE id = ?").get<{ id: string; name: string; slug: string; workspace: string }>(conceptId)
  if (!c) return undefined
  const attempts = db
    .prepare(
      `SELECT a.* FROM learning_attempts a JOIN observations o ON o.id = a.observation_id
       WHERE a.concept_id = ? AND o.status NOT IN ('forgotten','rejected') AND o.visibility = 'visible'
         AND o.scope_kind IN ('workspace','user') ORDER BY a.at`,
    )
    .all<{ evaluation: string; independent: number; at: number; kind: string }>(conceptId)
  const indep = attempts.filter((a) => a.independent && a.evaluation === "correct")
  const days = new Set(indep.map((a) => Math.floor(a.at / DAY)))
  const lastIndep = indep.length ? indep[indep.length - 1].at : null
  const spread = indep.length >= 2 ? indep[indep.length - 1].at - indep[0].at : 0
  const misconceptions = db
    .prepare(
      `SELECT COUNT(*) AS n FROM observations WHERE kind = 'misconception' AND status = 'active' AND visibility = 'visible' AND workspace = ?
       AND scope_kind IN ('workspace','user') AND json_extract(payload, '$.concept') = ? COLLATE NOCASE`,
    )
    .get<{ n: number }>(c.workspace, c.name)!.n
  const card = db.prepare("SELECT due_at FROM review_cards WHERE concept_id = ?").get<{ due_at: number }>(conceptId)
  const approved = db
    .prepare(
      `SELECT COUNT(*) AS n FROM observations WHERE kind = 'demonstrated-skill' AND status = 'active' AND visibility = 'visible'
       AND scope_kind IN ('workspace','user') AND workspace = ?
       AND json_extract(payload, '$.concept') = ? COLLATE NOCASE AND json_extract(payload, '$.mastery') = 1`,
    )
    .get<{ n: number }>(c.workspace, c.name)!.n
  let level: MasteryLevel = attempts.length ? "practicing" : "introduced"
  if (indep.length >= 1) level = "demonstrated"
  if (indep.length >= 2 && days.size >= 2 && spread >= 3 * DAY && misconceptions === 0) level = "retained"
  if ((level === "retained" || level === "demonstrated") && lastIndep && now - lastIndep > 45 * DAY) level = "needs-retention-check"
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    level,
    attempts: attempts.length,
    independentCorrect: indep.length,
    assisted: attempts.filter((a) => !a.independent).length,
    incorrect: attempts.filter((a) => a.evaluation === "incorrect").length,
    distinctDays: days.size,
    openMisconceptions: misconceptions,
    lastIndependentAt: lastIndep,
    dueAt: card?.due_at ?? null,
    approvedMastery: approved > 0,
  }
}

export function listConcepts(db: Database, workspace: string, now = Date.now()): ConceptState[] {
  return db
    .prepare("SELECT id FROM learning_concepts WHERE workspace = ? ORDER BY name")
    .all<{ id: string }>(workspace)
    .map((r) => conceptState(db, r.id, now)!)
    .filter(Boolean)
}

export function dueReviews(db: Database, workspace: string, now = Date.now(), limit = 20) {
  return db
    .prepare(
      `SELECT c.id, c.name, r.due_at, r.reps, r.lapses FROM review_cards r JOIN learning_concepts c ON c.id = r.concept_id
       WHERE c.workspace = ? AND r.due_at <= ? ORDER BY r.due_at, c.id LIMIT ?`,
    )
    .all<{ id: string; name: string; due_at: number; reps: number; lapses: number }>(workspace, now, limit)
}

export function reviewCalendar(db: Database, workspace: string, days = 30, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT r.due_at FROM review_cards r JOIN learning_concepts c ON c.id = r.concept_id WHERE c.workspace = ? AND r.due_at <= ?`,
    )
    .all<{ due_at: number }>(workspace, now + days * DAY)
  const buckets = new Map<string, number>()
  for (const r of rows) {
    const d = new Date(Math.max(r.due_at, now)).toISOString().slice(0, 10)
    buckets.set(d, (buckets.get(d) ?? 0) + 1)
  }
  return [...buckets.entries()].sort().map(([date, count]) => ({ date, count }))
}
