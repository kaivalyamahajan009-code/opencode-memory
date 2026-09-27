import type { Database } from "./sqlite"
import type { Payload } from "./schemas"
import { contentHash, deterministicId } from "./util"

/** Observations whose rows feed the workspace-wide learning/research tables. */
export const DOMAIN_SCOPES_SQL = "('workspace','user')"

/** The key a payload's research source is stored under: the DOI, else the URL. */
export function sourceLocator(p: Payload): string | undefined {
  return p.doi?.trim() || p.url?.trim() || undefined
}

/** Whitespace JS trim() removes (the common set), so SQL locators compare like sourceLocator. */
const WS = "char(32,9,10,11,12,13,160,65279)"
const LOCATOR_SQL = `COALESCE(NULLIF(TRIM(json_extract(payload, '$.doi'), ${WS}), ''), NULLIF(TRIM(json_extract(payload, '$.url'), ${WS}), ''))`

/**
 * Delete the research source an observation's payload points at, unless claim evidence or
 * another live workspace/user observation in the workspace still resolves to the same source
 * (exact locator match, mirroring upsertSource). Call inside a transaction.
 */
export function releaseResearchSource(db: Database, workspace: string, payload: Payload, excludeObservationId: string): boolean {
  const locator = sourceLocator(payload)
  if (!locator) return false
  const sourceId = deterministicId("src", workspace, locator)
  const stillUsed =
    db.prepare("SELECT 1 FROM claim_evidence WHERE source_id = ? LIMIT 1").get(sourceId) ||
    db
      .prepare(
        `SELECT 1 FROM observations WHERE id != ? AND workspace = ? AND status NOT IN ('forgotten','rejected')
         AND scope_kind IN ${DOMAIN_SCOPES_SQL} AND payload IS NOT NULL
         AND (CASE WHEN json_valid(payload) THEN ${LOCATOR_SQL} END) = ? LIMIT 1`,
      )
      .get(excludeObservationId, workspace, locator)
  if (stillUsed) return false
  return db.prepare("DELETE FROM research_sources WHERE id = ?").run(sourceId).changes > 0
}

export function upsertSource(db: Database, workspace: string, p: Payload, now = Date.now()): string | undefined {
  const url = p.url?.trim() || undefined
  const doi = p.doi?.trim() || undefined
  if (!url && !doi) return undefined
  const id = deterministicId("src", workspace, doi ?? url!)
  db.prepare(
    `INSERT INTO research_sources(id, workspace, url, doi, title, published_at, accessed_at, created_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title = COALESCE(research_sources.title, excluded.title),
       published_at = COALESCE(research_sources.published_at, excluded.published_at),
       accessed_at = COALESCE(excluded.accessed_at, research_sources.accessed_at)`,
  ).run(id, workspace, url ?? null, doi ?? null, p.title ?? null, p.publishedAt ?? null, p.accessedAt ?? null, now)
  return id
}

export function upsertClaim(db: Database, workspace: string, statement: string, p: Payload, confidence: number, now = Date.now()): string {
  const hash = contentHash(statement)
  const id = deterministicId("claim", workspace, hash)
  db.prepare(
    `INSERT INTO research_claims(id, workspace, statement, statement_hash, status, conditions, confidence, created_at, updated_at)
     VALUES (?,?,?,?,'open',?,?,?,?)
     ON CONFLICT(workspace, statement_hash) DO UPDATE SET updated_at = excluded.updated_at,
       conditions = COALESCE(excluded.conditions, research_claims.conditions)`,
  ).run(id, workspace, statement.slice(0, 1000), hash, p.conditions ?? null, confidence, now, now)
  return id
}

export function recomputeClaimStatus(db: Database, claimId: string, now = Date.now()): string {
  const claim = db.prepare("SELECT status FROM research_claims WHERE id = ?").get<{ status: string }>(claimId)
  if (!claim || claim.status === "superseded") return claim?.status ?? "open"
  const counts = db
    .prepare(
      `SELECT e.stance, COUNT(*) AS n FROM claim_evidence e JOIN observations o ON o.id = e.observation_id
       WHERE e.claim_id = ? AND o.status = 'active' AND o.visibility = 'visible' AND o.scope_kind IN ${DOMAIN_SCOPES_SQL} GROUP BY e.stance`,
    )
    .all<{ stance: string; n: number }>(claimId)
  const support = counts.find((c) => c.stance === "support")?.n ?? 0
  const contra = counts.find((c) => c.stance === "contradict")?.n ?? 0
  const status = support && contra ? "contested" : support ? "supported" : contra ? "refuted" : "open"
  db.prepare("UPDATE research_claims SET status = ?, updated_at = ? WHERE id = ?").run(status, now, claimId)
  return status
}

export type ResearchCommitInput = {
  workspace: string
  observationId: string
  kind: string
  content: string
  payload: Payload
  confidence: number
  at: number
}

/** Link research observations to claims and sources; returns the claim id when one was touched. */
export function recordResearch(db: Database, input: ResearchCommitInput): string | undefined {
  const p = input.payload
  const sourceId = upsertSource(db, input.workspace, p, input.at)
  let claimId: string | undefined
  if (input.kind === "claim" || input.kind === "conclusion" || input.kind === "hypothesis") {
    claimId = upsertClaim(db, input.workspace, p.claim?.trim() || input.content, p, input.confidence, input.at)
    if (sourceId || p.quotation) {
      db.prepare(
        `INSERT OR IGNORE INTO claim_evidence(id, claim_id, observation_id, source_id, stance, quotation, locator, created_at)
         VALUES (?,?,?,?,'support',?,?,?)`,
      ).run(deterministicId("ev", input.observationId, claimId), claimId, input.observationId, sourceId ?? null, p.quotation ?? null, p.locator ?? null, input.at)
    }
  } else if (input.kind === "evidence" || input.kind === "counter-evidence" || input.kind === "quotation") {
    const statement = p.claim?.trim()
    if (statement) {
      claimId = upsertClaim(db, input.workspace, statement, p, input.confidence, input.at)
      const stance = p.stance ?? (input.kind === "counter-evidence" ? "contradict" : "support")
      db.prepare(
        `INSERT OR IGNORE INTO claim_evidence(id, claim_id, observation_id, source_id, stance, quotation, locator, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        deterministicId("ev", input.observationId, claimId),
        claimId,
        input.observationId,
        sourceId ?? null,
        stance,
        p.quotation ?? null,
        p.locator ?? null,
        input.at,
      )
    }
  } else if (input.kind === "superseded-conclusion") {
    const statement = p.claim?.trim()
    if (statement) {
      const id = deterministicId("claim", input.workspace, contentHash(statement))
      db.prepare("UPDATE research_claims SET status = 'superseded', updated_at = ? WHERE id = ?").run(input.at, id)
    }
  }
  if (claimId) recomputeClaimStatus(db, claimId, input.at)
  return claimId
}

export function listClaims(db: Database, workspace: string) {
  const claims = db
    .prepare("SELECT * FROM research_claims WHERE workspace = ? ORDER BY updated_at DESC, id")
    .all<{ id: string; statement: string; status: string; conditions: string | null; confidence: number; updated_at: number }>(workspace)
  const ev = db.prepare(
    `SELECT e.id, e.stance, e.quotation, e.locator, e.observation_id, s.url, s.doi, s.title, o.content
     FROM claim_evidence e JOIN observations o ON o.id = e.observation_id LEFT JOIN research_sources s ON s.id = e.source_id
     WHERE e.claim_id = ? AND o.status = 'active' AND o.visibility = 'visible' AND o.scope_kind IN ${DOMAIN_SCOPES_SQL}`,
  )
  return claims.map((c) => {
    const evidence = ev.all<any>(c.id)
    return {
      ...c,
      support: evidence.filter((e) => e.stance === "support"),
      contradict: evidence.filter((e) => e.stance === "contradict"),
    }
  })
}

export function conflictReport(db: Database, workspace: string) {
  return listClaims(db, workspace).filter((c) => c.status === "contested")
}

export function listSources(db: Database, workspace: string) {
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM claim_evidence e WHERE e.source_id = s.id) AS evidence_count
       FROM research_sources s WHERE s.workspace = ? ORDER BY s.created_at DESC`,
    )
    .all<any>(workspace)
}
