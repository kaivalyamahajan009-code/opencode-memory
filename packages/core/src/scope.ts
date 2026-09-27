/**
 * Central scope policy. Every read path (tools, injection, API, source recall)
 * and every write/promotion path goes through these functions.
 *
 * Workspace is the sharing boundary; domain is only a classification.
 */

export type ScopeKind = "session" | "project" | "workspace" | "user"

export type AccessContext = {
  sessionId?: string
  projectId: string
  workspace: string
}

export type ObservationScopeRow = {
  scope_kind: ScopeKind
  session_id: string | null
  project_id: string | null
  workspace: string
  status: string
  visibility: string
  /** Who wrote the row: an agent's session-scoped row was never reviewed, so only its own session reads it. */
  actor?: string | null
}

export const READABLE_STATUSES = ["active", "pending_review"] as const

/** Session rows are shared within their project, except unreviewed agent writes, which stay in their session. */
export function sessionRowReadable(ctx: Pick<AccessContext, "projectId" | "sessionId">, row: Pick<ObservationScopeRow, "project_id" | "session_id" | "actor">): boolean {
  if (row.project_id !== ctx.projectId) return false
  return row.actor !== "agent" || (!!ctx.sessionId && row.session_id === ctx.sessionId)
}

export function canRead(ctx: AccessContext, row: ObservationScopeRow): boolean {
  if (row.visibility !== "visible") return false
  if (row.status === "pending_review") return !!ctx.sessionId && row.session_id === ctx.sessionId
  if (row.status !== "active") return false
  switch (row.scope_kind) {
    case "session":
      return sessionRowReadable(ctx, row)
    case "project":
      return row.project_id === ctx.projectId
    case "workspace":
      return row.workspace === ctx.workspace
    case "user":
      return true
  }
}

/** SQL fragment equivalent to canRead for alias `o`. Parameters are appended in order. */
export function readFilterSql(
  ctx: AccessContext,
  alias = "o",
  opts: { includeSuperseded?: boolean } = {},
): { sql: string; params: (string | null)[] } {
  const a = alias
  const current = opts.includeSuperseded ? `${a}.status IN ('active','superseded')` : `${a}.status = 'active'`
  const session = ctx.sessionId ?? "\u0000none"
  const sql = `(${a}.visibility = 'visible' AND (
    (${current} AND (
      (${a}.scope_kind = 'project' AND ${a}.project_id = ?)
      OR (${a}.scope_kind = 'session' AND ${a}.project_id = ? AND (${a}.actor != 'agent' OR ${a}.session_id = ?))
      OR (${a}.scope_kind = 'workspace' AND ${a}.workspace = ?)
      OR (${a}.scope_kind = 'user')
    ))
    OR (${a}.status = 'pending_review' AND ${a}.session_id = ?)
  ))`
  return { sql, params: [ctx.projectId, ctx.projectId, session, ctx.workspace, session] }
}

export type SourceOwner = { projectId: string; workspace: string }

/**
 * Source recall follows the linking observation: same project always; same
 * workspace only when the observation itself is workspace-scoped. User-scoped
 * facts from another workspace expose content but not their sources.
 */
export function canRecallSource(
  ctx: AccessContext,
  source: SourceOwner,
  via?: Pick<ObservationScopeRow, "scope_kind" | "workspace">,
): boolean {
  if (source.projectId === ctx.projectId) return true
  if (via && via.scope_kind === "workspace" && via.workspace === ctx.workspace && source.workspace === ctx.workspace)
    return true
  return false
}

export type WriteTarget = { kind: ScopeKind; projectId?: string; workspace?: string; sessionId?: string }

export function canWrite(ctx: AccessContext, target: WriteTarget): boolean {
  switch (target.kind) {
    case "session":
      return !!ctx.sessionId && target.sessionId === ctx.sessionId
    case "project":
      return target.projectId === ctx.projectId
    case "workspace":
    case "user":
      return false
  }
}

/** Promotion into durable shared scopes is allowed only toward the caller's own project/workspace or the user profile. */
export function canPromote(ctx: AccessContext, target: WriteTarget): boolean {
  switch (target.kind) {
    case "session":
      return false
    case "project":
      return target.projectId === ctx.projectId
    case "workspace":
      return target.workspace === ctx.workspace
    case "user":
      return true
  }
}
