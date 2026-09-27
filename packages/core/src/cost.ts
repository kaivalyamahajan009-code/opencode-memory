import type { Database } from "./sqlite"
import type { MemoryConfig } from "./config"
import { RunnerError } from "./runner"
import { randomId, startOfLocalDay } from "./util"

export type Usage = { costUsd: number; tokens: number; reservedUsd: number; runs: number; failures: number }

export function usageToday(db: Database, now = Date.now()): Usage {
  const since = startOfLocalDay(now)
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
         COALESCE(SUM(CASE WHEN status = 'running' THEN reserved_cost ELSE 0 END),0) AS reserved,
         COUNT(*) AS runs, COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),0) AS failures
       FROM operations WHERE started_at >= ?`,
    )
    .get<{ cost: number; tokens: number; reserved: number; runs: number; failures: number }>(since)!
  return { costUsd: r.cost, tokens: r.tokens, reservedUsd: r.reserved, runs: r.runs, failures: r.failures }
}

/** Atomically reserve budget for one model run. Throws cost_limit when the daily cap would be exceeded. */
export function reserveRun(
  db: Database,
  cfg: MemoryConfig["cost"],
  op: { kind: string; sessionId?: string; projectId?: string; refId?: string; runner: string },
  now = Date.now(),
): string {
  return db.tx(() => {
    const u = usageToday(db, now)
    const tomorrow = startOfLocalDay(now) + 86_400_000 - now + 1000
    if (u.costUsd + u.reservedUsd + cfg.estimatePerRunUsd > cfg.dailyCapUsd)
      throw new RunnerError("cost_limit", `daily memory cost cap $${cfg.dailyCapUsd} reached`, tomorrow)
    if (u.tokens >= cfg.dailyTokenCap) throw new RunnerError("cost_limit", `daily memory token cap ${cfg.dailyTokenCap} reached`, tomorrow)
    const id = randomId("op")
    db.prepare(
      `INSERT INTO operations(id, kind, session_id, project_id, ref_id, runner, status, reserved_cost, started_at)
       VALUES (?,?,?,?,?,?, 'running', ?, ?)`,
    ).run(id, op.kind, op.sessionId ?? null, op.projectId ?? null, op.refId ?? null, op.runner, cfg.estimatePerRunUsd, now)
    return id
  })
}

export function settleRun(
  db: Database,
  id: string,
  r: { cost: number; inputTokens: number; outputTokens: number; model?: string; status?: "succeeded" | "failed" | "stale"; error?: string; errorClass?: string },
  now = Date.now(),
) {
  db.prepare(
    `UPDATE operations SET status = ?, cost = ?, input_tokens = ?, output_tokens = ?, model = COALESCE(?, model), reserved_cost = 0,
       error = ?, error_class = ?, finished_at = ? WHERE id = ?`,
  ).run(r.status ?? "succeeded", r.cost, r.inputTokens, r.outputTokens, r.model ?? null, r.error?.slice(0, 2000) ?? null, r.errorClass ?? null, now, id)
}

export type RunUsage = { cost: number; inputTokens: number; outputTokens: number; model: string | undefined }

type AttachedUsage = { cost?: unknown; inputTokens?: unknown; outputTokens?: unknown; model?: unknown }

/** Runners attach the usage of a failed/timed-out run to the error; it was paid for. */
export function usageOfError(e: unknown): RunUsage | undefined {
  const u = (e ?? {}) as AttachedUsage
  if (typeof u.cost !== "number" || !Number.isFinite(u.cost)) return undefined
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return { cost: u.cost, inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), model: typeof u.model === "string" ? u.model : undefined }
}

/** Copy the usage attached to `source` onto a wrapping error so settling still sees what the run cost. */
export function withUsage<E extends Error>(wrapper: E, source: unknown): E {
  const u = usageOfError(source)
  if (u) Object.assign(wrapper, { cost: u.cost, inputTokens: u.inputTokens, outputTokens: u.outputTokens, model: u.model })
  return wrapper
}

/** Latest finish time of an operation with this status (index-backed; rows without finished_at fall back to started_at). */
export function lastOperationAt(db: Database, status: string): number | undefined {
  const finished = db.prepare("SELECT MAX(finished_at) AS t FROM operations WHERE status = ?").get<{ t: number | null }>(status)?.t ?? null
  const open = db.prepare("SELECT MAX(started_at) AS t FROM operations WHERE status = ? AND finished_at IS NULL").get<{ t: number | null }>(status)?.t ?? null
  const t = Math.max(finished ?? -Infinity, open ?? -Infinity)
  return Number.isFinite(t) ? t : undefined
}

/**
 * Drop finished operations older than `keepDays` and beyond the newest `keepRows`. Rows
 * started today are never removed: they feed the daily cost and token caps.
 */
export function pruneOperations(db: Database, now = Date.now(), opts: { keepDays?: number; keepRows?: number } = {}): number {
  const keepDays = opts.keepDays ?? 30
  const keepRows = opts.keepRows ?? 10_000
  const today = startOfLocalDay(now)
  let n = db
    .prepare("DELETE FROM operations WHERE status != 'running' AND started_at < ? AND started_at < ?")
    .run(now - keepDays * 86_400_000, today).changes
  n += db
    .prepare(
      `DELETE FROM operations WHERE status != 'running' AND started_at < ? AND id IN (
         SELECT id FROM operations ORDER BY started_at DESC LIMIT -1 OFFSET ?)`,
    )
    .run(today, keepRows).changes
  return n
}

/** Release reservations left by crashed processes. */
export function releaseStaleReservations(db: Database, olderThanMs = 60 * 60_000, now = Date.now()): number {
  return db
    .prepare("UPDATE operations SET status = 'abandoned', reserved_cost = 0, finished_at = ? WHERE status = 'running' AND started_at < ?")
    .run(now, now - olderThanMs).changes
}

export function recentOperations(db: Database, limit = 50) {
  return db.prepare("SELECT * FROM operations ORDER BY started_at DESC LIMIT ?").all<any>(limit)
}
