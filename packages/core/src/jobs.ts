import type { Database } from "./sqlite"

export type JobClaim = { key: string; owner: string; version: number }

/** Named singleton job with a lease (reflection per scope, vault writer, embeddings backfill). */
export function claimJob(db: Database, key: string, kind: string, owner: string, leaseMs: number, now = Date.now()): JobClaim | undefined {
  return db.tx(() => {
    const row = db
      .prepare("SELECT state, lease_owner, lease_expires_at, version, next_attempt_at FROM jobs WHERE key = ?")
      .get<{ state: string; lease_owner: string | null; lease_expires_at: number | null; version: number; next_attempt_at: number | null }>(key)
    if (row) {
      const leased = row.state === "running" && (row.lease_expires_at ?? 0) > now && row.lease_owner !== owner
      if (leased) return undefined
      if (row.next_attempt_at && row.next_attempt_at > now) return undefined
      const version = row.version + 1
      db.prepare("UPDATE jobs SET state = 'running', lease_owner = ?, lease_expires_at = ?, version = ?, attempts = attempts + 1, updated_at = ? WHERE key = ?").run(
        owner,
        now + leaseMs,
        version,
        now,
        key,
      )
      return { key, owner, version }
    }
    db.prepare("INSERT INTO jobs(key, kind, state, lease_owner, lease_expires_at, version, attempts, updated_at) VALUES (?,?, 'running', ?, ?, 1, 1, ?)").run(
      key,
      kind,
      owner,
      now + leaseMs,
      now,
    )
    return { key, owner, version: 1 }
  })
}

export function jobHeld(db: Database, claim: JobClaim): boolean {
  const row = db.prepare("SELECT state, lease_owner, version FROM jobs WHERE key = ?").get<{ state: string; lease_owner: string; version: number }>(claim.key)
  return !!row && row.state === "running" && row.lease_owner === claim.owner && row.version === claim.version
}

export function finishJob(db: Database, claim: JobClaim, result: { error?: string; retryAfterMs?: number } = {}, now = Date.now()) {
  db.prepare(
    "UPDATE jobs SET state = ?, lease_owner = NULL, lease_expires_at = NULL, error = ?, next_attempt_at = ?, attempts = CASE WHEN ? IS NULL THEN 0 ELSE attempts END, updated_at = ? WHERE key = ? AND lease_owner = ? AND version = ?",
  ).run(
    result.error ? "failed" : "idle",
    result.error ?? null,
    result.retryAfterMs ? now + result.retryAfterMs : null,
    result.error ?? null,
    now,
    claim.key,
    claim.owner,
    claim.version,
  )
}

export function listJobs(db: Database) {
  return db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC").all<any>()
}
