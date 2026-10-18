import { realpathSync, statSync } from "node:fs"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  estimateTokens,
  inForgetScope,
  isUncPath,
  RECALL_GUARANTEE,
  redact,
  sessionUserText,
  setArtifactConcepts,
  type AccessContext,
  type InstanceAdapter,
  type MemoryEngine,
  type RecallResult,
  type ScopeKind,
} from "@opencode-memory/core"
import { tool } from "@opencode-ai/plugin"
import { learningAgentOverride } from "./learning-agent"

const z = tool.schema

/** Structured fields per kind; core validates them again and keeps only the ones the kind uses. */
const rememberPayloadSchema = z
  .object({
    key: z.string().optional().describe("preference, learning-preference, personal-fact, goal: the subject key"),
    value: z.string().optional().describe("preference, learning-preference, personal-fact, goal: the value"),
    concept: z.string().optional().describe("learning kinds and artifact: the concept name"),
    question: z.string().optional(),
    answer: z.string().optional(),
    evaluation: z.enum(["correct", "partial", "incorrect"]).optional(),
    hints: z.number().int().min(0).optional(),
    independent: z.boolean().optional(),
    mastery: z.boolean().optional().describe("demonstrated-skill: claims mastery (always goes to human review)"),
    reviewAt: z.string().optional().describe("quiz-attempt, retention-check, next-review: ISO date"),
    claim: z.string().optional().describe("research kinds: the claim text"),
    stance: z.enum(["support", "contradict"]).optional(),
    url: z.string().optional(),
    doi: z.string().optional(),
    title: z.string().optional(),
    publishedAt: z.string().optional(),
    accessedAt: z.string().optional(),
    locator: z.string().optional(),
    quotation: z.string().optional(),
    conditions: z.string().optional(),
    path: z.string().optional().describe("artifact: project-relative file path"),
  })
  .describe("Structured fields for the kind")

function ctxFor(engine: MemoryEngine, adapter: InstanceAdapter, sessionID: string): AccessContext {
  return engine.contextForSession(sessionID) ?? engine.context(adapter.project.id, sessionID)
}

/** Same workspace as learn-agent injection, so due reviews and recorded attempts agree. */
function learningCtx(
  engine: MemoryEngine,
  adapter: InstanceAdapter,
  sessionID: string,
  agent: string | undefined,
): AccessContext {
  const ctx = ctxFor(engine, adapter, sessionID)
  const override = learningAgentOverride(engine.config, agent)
  return override ? { ...ctx, workspace: override.workspace } : ctx
}

function line(o: { id: string; kind?: string; scope_kind?: string; status?: string; content: string; confidence?: number }): string {
  const bits = [o.kind, o.scope_kind, o.status].filter(Boolean)
  const conf = o.confidence != null ? ` ${o.confidence.toFixed(2)}` : ""
  return `- ${o.content} (${o.id}${bits.length ? ` · ${bits.join(" · ")}` : ""}${conf})`
}

export function recallText(r: RecallResult): string {
  if (!r.ok) return `Recall failed: ${r.error}`
  const lines = [`Guarantee: ${r.guarantee}`, `Session ${r.sessionId} seq ${r.fromSeq}-${r.toSeq}`]
  if (r.cited?.length) lines.push(`Cited ranges: ${r.cited.map((c) => `${c[0]}-${c[1]}`).join(", ")}`)
  for (const m of r.messages) {
    const flags = [m.status !== "present" ? m.status : "", m.agent ? `agent=${m.agent}` : ""].filter(Boolean)
    lines.push(`[${m.role} seq=${m.seq}${flags.length ? ` ${flags.join(" ")}` : ""}]`)
    for (const p of m.parts) {
      const marks: string[] = []
      if (p.forgotten) marks.push("forgotten")
      if (p.redactions) marks.push(`redacted x${p.redactions}`)
      if (p.omitted) marks.push(`omitted ${p.omitted} chars`)
      if (p.truncated) marks.push("truncated=true")
      lines.push(`  ${p.text || "(empty)"}${marks.length ? ` [${marks.join(", ")}]` : ""}`)
    }
  }
  if (r.nextCursor) {
    const c = r.nextCursor
    const args = { sessionId: c.sessionId, fromSeq: c.fromSeq, toSeq: c.toSeq, context: c.context, ...(c.observationId ? { observationId: c.observationId } : {}) }
    lines.push(`[truncated: more retained source exists after seq ${r.toSeq}. Continue with memory_recall_source ${JSON.stringify(args)}]`)
  } else if (r.truncated) {
    lines.push("[truncated: a message was cut to fit the recall budget; parts marked truncated=true are incomplete]")
  }
  return lines.join("\n")
}

export function pausedReasonText(reason: string): string {
  if (reason === "manual") return "paused by the user"
  if (reason === "auth") return "paused: the memory model's credentials were rejected; fix them, then resume"
  return `paused: ${reason}`
}

function when(at: number | null | undefined): string {
  return at ? new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never"
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

/** Word-boundary match of ≥3 words of `quote` inside `hay`. */
export function quotedInText(hay: string, quote: string): boolean {
  const needle = words(quote)
  if (needle.length < 3) return false
  const hayWords = words(hay)
  for (let i = 0; i + needle.length <= hayWords.length; i++) {
    if (needle.every((w, j) => hayWords[i + j] === w)) return true
  }
  const escaped = needle.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
  return new RegExp(`\\b${escaped}\\b`, "i").test(hay)
}

function latestUserText(engine: MemoryEngine, sessionID: string, fallback?: string): string {
  if (fallback?.trim()) return fallback
  try {
    return sessionUserText(engine.db, sessionID, 1)
  } catch {
    return ""
  }
}

function clean(s: string | undefined, max = 1000): string | undefined {
  if (s == null) return undefined
  const t = redact(s.trim()).text.slice(0, max)
  return t || undefined
}

/**
 * Agent-recorded learning/research item, written through engine.remember (actor "agent")
 * with its payload so core validates it and decides placement. The row stays session-scoped
 * (or goes to review), so it never reaches the workspace domain tables (claims, concepts)
 * that other sessions read until a human approves or promotes it.
 */
function recordDomainItem(
  engine: MemoryEngine,
  ctx: AccessContext,
  sessionID: string,
  input: { kind: string; content: string; payload: Record<string, unknown> },
): { ok: true; id: string; status: string } | { ok: false; error: string } {
  const payload = Object.fromEntries(Object.entries(input.payload).filter(([, v]) => v !== undefined))
  const r = engine.remember(ctx, { content: input.content, kind: input.kind, scope: "session", actor: "agent", sessionId: sessionID, payload })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, id: r.id, status: r.status }
}

export function forgetPreviews(engine: MemoryEngine, ids: string[], ctx: AccessContext) {
  return ids.map((id) => {
    const row = engine.observation(id)
    if (!row) return { id, preview: "(unknown id; will be skipped)" }
    if (!inForgetScope(ctx, row)) return { id, preview: "(outside this project/workspace; will be skipped)" }
    const text = redact(row.content ?? "").text
    return { id, preview: text.length > 180 ? `${text.slice(0, 180)}…` : text || "(empty)" }
  })
}

const ARTIFACT_EXT = new Set([".svg", ".mmd", ".mermaid"])

export type ArtifactFs = { realpath(p: string): string; isFile(p: string): boolean }

const nodeArtifactFs: ArtifactFs = {
  realpath: (p) => realpathSync.native(p),
  isFile: (p) => statSync(p).isFile(),
}

function inside(root: string, file: string): boolean {
  const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s)
  const rel = relative(fold(root), fold(file))
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve an artifact path against the session's project directory (the root core's
 * capture uses). Paths outside it, before or after resolving symlinks, are rejected, as are
 * UNC and device paths, before any filesystem call.
 */
export function resolveArtifactFile(raw: string, directory: string | undefined, fs: ArtifactFs = nodeArtifactFs): { path: string } | { error: string } {
  const p = raw.trim()
  if (!p || p.includes("\0")) return { error: "Give the path of an .svg, .mmd or .mermaid file in this project." }
  if (isUncPath(p)) return { error: `Rejected ${p}: network (UNC) and device paths cannot be registered.` }
  if (!directory || isUncPath(directory)) return { error: "Rejected: this session has no local project directory." }
  const base = resolve(directory)
  const full = isAbsolute(p) ? resolve(p) : resolve(base, p)
  if (isUncPath(full)) return { error: `Rejected ${p}: network (UNC) and device paths cannot be registered.` }
  if (!ARTIFACT_EXT.has(extname(full).toLowerCase())) return { error: `Rejected ${p}: only .svg, .mmd and .mermaid files can be registered.` }
  if (!inside(base, full)) return { error: `Rejected ${p}: it is outside this project (${base}). Only files inside the project directory can be registered.` }
  let root: string
  let real: string
  try {
    root = fs.realpath(base)
    real = fs.realpath(full)
  } catch {
    return { error: `No SVG/Mermaid artifact at ${p}.` }
  }
  if (isUncPath(real) || !inside(root, real) || !ARTIFACT_EXT.has(extname(real).toLowerCase()))
    return { error: `Rejected ${p}: it resolves to a file outside this project. Only files inside the project directory can be registered.` }
  try {
    if (!fs.isFile(real)) return { error: `No SVG/Mermaid artifact at ${p}.` }
  } catch {
    return { error: `No SVG/Mermaid artifact at ${p}.` }
  }
  return { path: real }
}

export function createTools(
  engine: MemoryEngine,
  adapter: InstanceAdapter,
  opts?: { lastUser?: (sessionID: string) => string | undefined },
) {
  const dueReviews = tool({
    description: "List learning concepts due for review in this workspace.",
    args: {},
    async execute(_args, context) {
      const ctx = learningCtx(engine, adapter, context.sessionID, context.agent)
      const due = engine.learning(ctx.workspace).due
      if (!due.length) return "No reviews due."
      return ["Due for review:", ...due.map((d) => `- ${d.name} (${d.id}) due ${new Date(d.due_at).toISOString()}`)].join("\n")
    },
  })
  const claimsTool = tool({
    description: "List research claims and contested conflicts in this workspace.",
    args: {},
    async execute(_args, context) {
      const ctx = ctxFor(engine, adapter, context.sessionID)
      const r = engine.research(ctx.workspace)
      const claims = r.claims.slice(0, 20)
      const lines = [`${claims.length} claims:`]
      for (const c of claims) {
        lines.push(`- ${c.statement} [${c.status}] (${c.id}) +${c.support.length}/-${c.contradict.length}`)
      }
      if (r.conflicts.length) {
        lines.push("Conflicts:")
        for (const c of r.conflicts.slice(0, 10)) lines.push(`- ${c.statement} (${c.id})`)
      }
      return lines.join("\n")
    },
  })

  return {
    memory_status: tool({
      description: "Show observational memory status for this session: unobserved tokens, observations, errors.",
      args: {},
      async execute(_args, context) {
        const s = engine.sessionStatus(context.sessionID)
        const g = engine.globalStatus()
        const pending = s.unobservedTokens
        const activation = s.activationTokens
        const state = !s.known
          ? "unknown"
          : g.paused || s.paused
            ? "paused"
            : s.observing
              ? "observing"
              : g.reflecting
                ? "reflecting"
                : pending
                  ? "buffering"
                  : "idle"
        const paused = g.paused && g.pausedReason ? ` (${pausedReasonText(g.pausedReason)})` : !g.paused && s.paused ? " (paused for this session)" : ""
        return [
          `Memory ${state}${paused}`,
          `Session ${s.sessionId}${s.title ? ` "${s.title}"` : ""}`,
          `Auto-activation ${pending} / ${activation} unobserved tokens (buffer chunks ${s.bufferTokens}; captured ${s.capturedTokens})`,
          `Observations ${s.observations} (${s.observationTokens} tok)`,
          s.currentTask ? `Current task: ${s.currentTask}` : null,
          s.suggestedNext ? `Suggested next: ${s.suggestedNext}` : null,
          s.lastError ? `Last error: ${s.lastError.error}` : null,
          `Last success ${when(g.lastSuccessAt)} · last failure ${when(g.lastFailureAt)}`,
          `FTS5 ${g.fts5 ? "yes" : "no"} · driver ${g.driver} · review ${g.reviewOpen}`,
        ]
          .filter(Boolean)
          .join("\n")
      },
    }),
    memory_observations: tool({
      description: "List recent memory observations for this session/project, with ids.",
      args: {
        limit: z.number().int().min(1).max(50).optional(),
        kinds: z.string().optional(),
      },
      async execute(args, context) {
        const ctx = ctxFor(engine, adapter, context.sessionID)
        const kinds = args.kinds?.split(",").map((s) => s.trim()).filter(Boolean)
        const rows = engine.list(ctx, { kinds, limit: args.limit ?? 20 })
        if (!rows.length) return "No observations."
        return [`${rows.length} observations:`, ...rows.map(line)].join("\n")
      },
    }),
    memory_search: tool({
      description: "Search observational memory. Returns matching observations with ids.",
      args: {
        query: z.string(),
        limit: z.number().int().min(1).max(30).optional(),
      },
      async execute(args, context) {
        const ctx = ctxFor(engine, adapter, context.sessionID)
        const hits = engine.search(ctx, args.query, { limit: args.limit ?? 10 })
        if (!hits.length) return `No matches for ${JSON.stringify(args.query)}.`
        return hits.map((h) => `${line(h.row)} score=${h.score.toFixed(2)}`).join("\n")
      },
    }),
    memory_recall_source: tool({
      description: `Recall the exact retained source behind an observation or session range. ${RECALL_GUARANTEE}. A truncated result ends with the arguments (sessionId, fromSeq, toSeq, context, observationId) to pass back for the next page.`,
      args: {
        observationId: z.string().optional(),
        sessionId: z.string().optional(),
        fromSeq: z.number().int().optional(),
        toSeq: z.number().int().optional(),
        context: z.number().int().min(0).max(10).optional(),
      },
      async execute(args, context) {
        const ctx = ctxFor(engine, adapter, context.sessionID)
        return recallText(
          engine.recallSource(ctx, {
            observationId: args.observationId,
            sessionId: args.sessionId,
            fromSeq: args.fromSeq,
            toSeq: args.toSeq,
            context: args.context,
          }),
        )
      },
    }),
    memory_remember: tool({
      description:
        "Write a memory observation. Shared workspace/user scope goes to review when written by the agent. Optional payload carries the kind's structured fields; fields that do not belong to the kind are dropped.",
      args: {
        content: z.string(),
        kind: z.string().optional(),
        scope: z.enum(["session", "project", "workspace", "user"]).optional(),
        payload: rememberPayloadSchema.optional(),
      },
      async execute(args, context) {
        const ctx = ctxFor(engine, adapter, context.sessionID)
        const payload = args.payload ? Object.fromEntries(Object.entries(args.payload).filter(([, v]) => v !== undefined)) : undefined
        const r = engine.remember(ctx, {
          content: args.content,
          kind: args.kind,
          scope: args.scope as ScopeKind | undefined,
          actor: "agent",
          sessionId: context.sessionID,
          ...(payload ? { payload } : {}),
        })
        if (!r.ok) return `Could not remember: ${r.error}`
        return `Remembered ${r.id} (${r.scope}, ${r.status})`
      },
    }),
    memory_supersede: tool({
      description: "Replace an existing observation with corrected content. Shared memories cannot be replaced by the agent.",
      args: {
        id: z.string(),
        content: z.string(),
        reason: z.string().optional(),
      },
      async execute(args, context) {
        const ctx = ctxFor(engine, adapter, context.sessionID)
        const r = engine.supersede(ctx, args.id, args.content, args.reason ?? "agent update", "agent")
        if (!r.ok) return `Could not supersede: ${r.error}`
        return `Superseded ${args.id} -> ${r.id}`
      },
    }),
    memory_forget: tool({
      description: "Forget observations by id (asks permission first), or pass a text query to list candidates without deleting.",
      args: {
        ids: z.array(z.string()).optional(),
        query: z.string().optional(),
        reason: z.string().optional(),
      },
      async execute(args, context) {
        const ctx = ctxFor(engine, adapter, context.sessionID)
        const ids = (args.ids ?? []).map((s) => s.trim()).filter(Boolean)
        if (!ids.length) {
          if (!args.query?.trim()) return "Give observation ids to forget, or a text query to list candidates."
          const cand = engine.forgetCandidates(args.query, ctx)
          if (!cand.length) return "No matching observations."
          return ["Candidates (not forgotten):", ...cand.map((c) => `- ${c.content} (${c.id}) score=${c.score.toFixed(2)}`)].join("\n")
        }
        await context.ask({
          permission: "memory_forget",
          patterns: ids,
          always: [],
          metadata: { reason: args.reason ?? "agent forget", sessionID: context.sessionID, items: forgetPreviews(engine, ids, ctx) },
        })
        const r = await engine.forget(ids, { actor: "agent", reason: args.reason ?? "agent forget", purgeSources: "none", ctx, scope: "ctx" })
        const skipped = r.skipped?.length ? ` Skipped ${r.skipped.length}: ${r.skipped.join(", ")}.` : ""
        return `Forgot ${r.observationIds.length} observation(s): ${r.observationIds.join(", ") || "(none)"}.${skipped} Tombstones kept.`
      },
    }),
    memory_flush: tool({
      description: "Flush unobserved session text through the observer now. Waits up to 120s.",
      args: {},
      async execute(_args, context) {
        if (context.abort.aborted) return "Aborted."
        const flush = engine.flush(context.sessionID, { wait: true, timeoutMs: 120_000 })
        let onAbort = () => {}
        const aborted = new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted")
          context.abort.addEventListener("abort", onAbort, { once: true })
        })
        try {
          const r = await Promise.race([flush, aborted])
          if (r === "aborted") {
            flush.catch(() => {})
            return "Aborted. The observer keeps running in the background."
          }
          const n = r.outcomes.reduce((a, o) => a + (o.status === "succeeded" ? o.commit.inserted : 0), 0)
          return `Flushed ${r.chunks.length} chunk(s); waited=${r.waited}; inserted ${n} observation(s).`
        } finally {
          context.abort.removeEventListener("abort", onAbort)
        }
      },
    }),
    learning_due: dueReviews,
    learning_due_reviews: dueReviews,
    learning_record_attempt: tool({
      description:
        "Record a learner quiz/retention attempt. The quoted answer must appear in the latest user message (≥3 words). Not treated as human-verified.",
      args: {
        concept: z.string(),
        question: z.string().optional(),
        answer: z.string(),
        evaluation: z.enum(["correct", "partial", "incorrect"]).optional(),
        hints: z.number().int().min(0).max(50).optional(),
        independent: z.boolean().optional(),
        kind: z.enum(["quiz-attempt", "retention-check", "demonstrated-skill"]).optional(),
      },
      async execute(args, context) {
        const ctx = learningCtx(engine, adapter, context.sessionID, context.agent)
        const userText = latestUserText(engine, context.sessionID, opts?.lastUser?.(context.sessionID))
        if (!quotedInText(userText, args.answer)) {
          return "Rejected: the learner's answer must appear in the latest user message (word-boundary match, at least 3 words)."
        }
        const kind = args.kind ?? "quiz-attempt"
        const concept = clean(args.concept, 200)
        const answer = clean(args.answer)
        if (!concept || !answer) return "Rejected: concept and answer are required."
        const r = recordDomainItem(engine, ctx, context.sessionID, {
          kind,
          content: `${kind} on ${concept}: ${answer}`,
          payload: {
            concept,
            question: clean(args.question),
            answer,
            evaluation: args.evaluation ?? "partial",
            hints: args.hints ?? 0,
            independent: args.independent === true,
          },
        })
        if (!r.ok) return `Could not record attempt: ${r.error}`
        const state = r.status === "active" ? "recorded" : "sent to review"
        return `Agent-observed attempt ${r.id} for ${concept} ${state}. Not human-verified.`
      },
    }),
    research_claims: claimsTool,
    research_conflicts: tool({
      description: "List contested research claims (conflicts view) in this workspace.",
      args: {},
      async execute(_args, context) {
        const ctx = ctxFor(engine, adapter, context.sessionID)
        const conflicts = engine.research(ctx.workspace).conflicts
        if (!conflicts.length) return "No contested claims."
        return ["Conflicts:", ...conflicts.slice(0, 20).map((c) => `- ${c.statement} [${c.status}] (${c.id})`)].join("\n")
      },
    }),
    research_claim: tool({
      description: "Record a research claim scoped to this workspace. Evidence is marked agent-observed, not human-verified.",
      args: {
        claim: z.string(),
        url: z.string().optional(),
        doi: z.string().optional(),
        title: z.string().optional(),
        quotation: z.string().optional(),
        locator: z.string().optional(),
        conditions: z.string().optional(),
      },
      async execute(args, context) {
        const ctx = ctxFor(engine, adapter, context.sessionID)
        const claim = clean(args.claim)
        if (!claim) return "Rejected: claim is required."
        const r = recordDomainItem(engine, ctx, context.sessionID, {
          kind: "claim",
          content: claim,
          payload: {
            claim,
            url: clean(args.url, 500),
            doi: clean(args.doi, 200),
            title: clean(args.title, 300),
            quotation: clean(args.quotation),
            locator: clean(args.locator, 200),
            conditions: clean(args.conditions),
          },
        })
        if (!r.ok) return `Could not record claim: ${r.error}`
        const state = r.status === "active" ? "recorded" : "sent to review"
        return `Agent-observed claim ${r.id} ${state}. Not human-verified.`
      },
    }),
    research_evidence: tool({
      description: "Record evidence for a research claim. Marked agent-observed, not human-verified.",
      args: {
        claim: z.string(),
        stance: z.enum(["support", "contradict"]).optional(),
        quotation: z.string().optional(),
        url: z.string().optional(),
        doi: z.string().optional(),
        locator: z.string().optional(),
        content: z.string().optional(),
      },
      async execute(args, context) {
        const ctx = ctxFor(engine, adapter, context.sessionID)
        const claim = clean(args.claim)
        const content = clean(args.content) ?? clean(args.quotation) ?? claim
        if (!claim || !content) return "Rejected: claim is required."
        const r = recordDomainItem(engine, ctx, context.sessionID, {
          kind: "evidence",
          content,
          payload: {
            claim,
            stance: args.stance ?? "support",
            quotation: clean(args.quotation),
            url: clean(args.url, 500),
            doi: clean(args.doi, 200),
            locator: clean(args.locator, 200),
          },
        })
        if (!r.ok) return `Could not record evidence: ${r.error}`
        const state = r.status === "active" ? "recorded" : "sent to review"
        return `Agent-observed ${args.stance ?? "support"} evidence ${r.id} ${state}. Not human-verified.`
      },
    }),
    artifact_register: tool({
      description: "Index an SVG or Mermaid artifact written to disk in this project.",
      args: {
        path: z.string(),
        title: z.string().optional(),
        concepts: z.array(z.string()).optional(),
      },
      async execute(args, context) {
        const resolved = resolveArtifactFile(args.path, context.directory || adapter.directory)
        if ("error" in resolved) return resolved.error
        const ids = engine.captureToolArtifacts(adapter, context.sessionID, "write", { filePath: resolved.path })
        if (!ids.length)
          return `Could not register ${args.path}: memory is off for this session, or the file is over 2 MB or outside this window's project.`
        if (args.title || args.concepts?.length) {
          for (const id of ids) setArtifactConcepts(engine.db, id, args.concepts ?? [], args.title)
        }
        return `Registered ${ids.join(", ")}`
      },
    }),
  }
}

export function compactionNote(engine: MemoryEngine, sessionID: string, budget = 800): string | undefined {
  const s = engine.sessionStatus(sessionID)
  if (!s.known || s.internal || s.excluded) return undefined
  const ctx = engine.contextForSession(sessionID)
  const rows = ctx ? engine.list(ctx, { scopes: ["session"], limit: 20 }) : []
  const lines: string[] = ["Observational memory (compacted note):"]
  if (s.currentTask) lines.push(`Current task: ${s.currentTask}`)
  if (s.suggestedNext) lines.push(`Suggested next: ${s.suggestedNext}`)
  if (ctx) {
    const keys = [`workspace:${ctx.workspace}`, `project:${ctx.projectId}`]
    try {
      const topics = engine
        .topics(keys)
        .filter((t) => t.state !== "deleted")
        .slice(0, 6)
      const indexBits = topics
        .map((t: any) => (t.summary ? `- ${t.title}: ${String(t.summary).slice(0, 160)}` : null))
        .filter(Boolean)
      if (indexBits.length) {
        lines.push("INDEX:")
        lines.push(...(indexBits as string[]))
      }
      const journey = engine.db
        .prepare(`SELECT at, entry FROM journey_entries WHERE scope_key IN (?, ?) ORDER BY at DESC LIMIT 8`)
        .all<{ at: number; entry: string }>(...keys)
      if (journey.length) {
        lines.push("JOURNEY:")
        for (const j of journey) lines.push(`- ${new Date(j.at).toISOString().slice(0, 10)}: ${j.entry.slice(0, 160)}`)
      }
    } catch {}
  }
  for (const o of rows) {
    const next = line(o)
    if (estimateTokens(lines.join("\n") + "\n" + next) > budget) break
    lines.push(next)
  }
  const text = lines.join("\n")
  return estimateTokens(text) ? text.slice(0, budget * 4) : undefined
}
