import { createServer } from "node:http"
import { readFileSync, existsSync, statSync } from "node:fs"
import { extname, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"

const dir = fileURLToPath(new URL(".", import.meta.url))
const dist = join(dir, "..", "dist")
const port = Number(process.env.PORT || process.argv[2] || 4777)
const token = "dev-token"
const now = Date.now()
const sessionId = "sess_demo"
const projectId = "proj_demo"
const workspace = "learning"
const obsId = "obs_recursion"
const reviewId = "rev_mastery"
const conceptId = "con_recursion"

const config = {
  port,
  allowedOrigins: ["oc://renderer", "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:4444", `http://127.0.0.1:${port}`],
  version: "0.1.0",
}

const observation = {
  id: obsId,
  scope_kind: "session",
  session_id: sessionId,
  project_id: projectId,
  workspace,
  chunk_id: "chk_1",
  kind: "quiz-attempt",
  domain: "learning",
  content: "Solved unseen recursion problem independently",
  content_hash: "abc",
  event_at: now - 3_600_000,
  observed_at: now - 3_500_000,
  confidence: 0.95,
  evidence_type: "quiz",
  priority: "high",
  status: "active",
  visibility: "visible",
  review_reason: null,
  target_scope: null,
  supersedes_id: null,
  superseded_by: null,
  expires_at: null,
  pinned: 0,
  payload: { concept: "Recursion", evaluation: "correct", independent: true },
  subject_key: "skill:recursion",
  from_recall: 0,
  generation: 3,
  token_est: 42,
  actor: "observer",
  updated_at: now - 3_500_000,
}

const misconception = {
  ...observation,
  id: "obs_mis",
  kind: "misconception",
  evidence_type: "observed",
  confidence: 0.8,
  content: "Thought tail recursion always uses extra stack frames",
  event_at: now - 4_200_000,
  observed_at: now - 4_100_000,
}

const pending = {
  ...observation,
  id: "obs_mastery",
  kind: "demonstrated-skill",
  evidence_type: "inferred",
  confidence: 0.7,
  status: "pending_review",
  content: "Mastered recursion",
  review_reason: "mastery claims require human review",
  target_scope: "workspace",
}

const FOREIGN_ID = "obs_foreign"

const similar = {
  ...observation,
  id: "obs_similar",
  content: "Solved an unseen recursion problem without hints",
  observed_at: now - 3_400_000,
}

/** Owned by another project: a global user forget reaches it, a session-scoped (agent) forget does not. */
const foreign = {
  ...observation,
  id: FOREIGN_ID,
  scope_kind: "project",
  session_id: "sess_other",
  project_id: "proj_other",
  workspace: "research",
  content: "Solved unseen recursion problem in the other project",
}

const rows = [observation, misconception, pending, similar, foreign]

const status = {
  global: {
    byScope: [
      { scope_kind: "session", status: "active", n: 4 },
      { scope_kind: "workspace", status: "pending_review", n: 1 },
    ],
    reviewOpen: 1,
    quarantined: 1,
    queued: 1,
    vaultPending: 0,
    topicConflicts: 0,
    usage: { costUsd: 0.02, tokens: 41000, reservedUsd: 0, runs: 6, failures: 0 },
    cap: { usd: 1, tokens: 2_000_000 },
    recentFailures: [],
    instances: [{ id: "inst_1", pid: 4242, directory: "C:/Users/demo/learn", project_id: projectId, heartbeat_at: now - 4000 }],
    // MOCK_PAUSED=auth starts in the engine's auth auto-pause state.
    paused: !!process.env.MOCK_PAUSED,
    pausedReason: process.env.MOCK_PAUSED || null,
    observing: true,
    reflecting: false,
    lastFailureAt: null,
    lastSuccessAt: now - 4000,
    fts5: true,
    driver: "bun:sqlite",
    embeddings: null,
    dataDir: "/tmp/opencode-memory",
    vaultDir: "/tmp/opencode-memory/vault",
  },
  session: {
    sessionId,
    known: true,
    projectId,
    title: "Recursion practice",
    capturedTokens: 22000,
    unobservedTokens: 18200,
    unchunkedTokens: 4200,
    oldestUnobservedAt: now - 120000,
    bufferTokens: 6000,
    activationTokens: 30000,
    lastSeq: 48,
    chunkedSeq: 40,
    coveredSeq: 40,
    chunks: { pending: { n: 1, tokens: 14000 }, succeeded: { n: 3, tokens: 9000 }, quarantined: { n: 1, tokens: 2000 } },
    observations: 4,
    observationTokens: 9400,
    injectedTokens: 2140,
    injectedAt: now - 60000,
    currentTask: "Recursion - base cases",
    suggestedNext: "quiz on tail recursion",
    lastError: null,
    paused: false,
    excluded: false,
    forgotten: false,
    internal: false,
    reverted: false,
    forkedFrom: null,
    observing: true,
  },
}

const memoryConfig = {
  port,
  allowedOrigins: config.allowedOrigins,
  dataDir: "/tmp/opencode-memory",
  vaultDir: "/tmp/opencode-memory/vault",
  observe: { bufferTokens: 6000, activationTokens: 30000, maxChunkTokens: 12000, minFlushTokens: 150, idleFlushMs: 90000 },
  reflect: { thresholdTokens: 40000, minNewDurable: 25 },
  inject: { enabled: true, deadlineMs: 250, budget: { profile: 600, workspace: 900, project: 900, session: 2400, task: 300, recall: 900 } },
  cost: { dailyCapUsd: 1, dailyTokenCap: 2_000_000, estimatePerRunUsd: 0.01 },
  runner: {
    kind: "opencode-session",
    timeoutMs: 180000,
    model: { providerID: "opencode", modelID: "small" },
    direct: { baseURL: "http://127.0.0.1:9", apiKeyEnv: "OM_KEY", headers: { Authorization: "secret-token" } },
  },
  pruning: { enabled: false, keepRecentTurns: 4 },
  backup: { keep: 14, autoDaily: true, dir: "/tmp/opencode-memory/backups" },
  embeddings: { provider: "none", baseURL: "http://127.0.0.1:9", apiKeyEnv: "OM_EMBED", headers: { Authorization: "embed-secret" } },
}

const block = `<opencode-memory hash="3fa9c2e1b7d4">
Observational memory from this user's past and current sessions.
## Current task
- Current task: Recursion - base cases
- Suggested next: quiz on tail recursion
</opencode-memory>`

const payload = {
  "/health": { ok: true, name: "opencode-memory", version: "0.1.0", api: 1 },
  "/api/status": { ok: true, data: status },
  "/api/config": { ok: true, data: memoryConfig },
  "/api/projects": {
    ok: true,
    data: [{ id: projectId, workspace, domain: "learning", name: "Recursion", directory: "C:/Users/demo/learn", sessions: 1, observations: 4 }],
  },
  "/api/workspaces": { ok: true, data: [workspace, "research"] },
  "/api/sessions": {
    ok: true,
    data: [
      {
        id: sessionId,
        project_id: projectId,
        parent_id: null,
        title: "Recursion practice",
        excluded: 0,
        paused: 0,
        deleted_at: null,
        revert_message_id: null,
        fork_source: null,
        last_activity_at: now,
        project_name: "Recursion",
        workspace,
        directory: "C:/Users/demo/learn",
        observations: 4,
        tokens: 22000,
      },
    ],
  },
  // Core's listReviewItems: `SELECT r.*, r.kind AS review_kind, o.content, o.kind, ...` LEFT JOIN observations,
  // so `kind` is the linked observation's kind and every o.* column is null for a vault conflict (it links a topic).
  "/api/review": {
    ok: true,
    data: [
      {
        id: reviewId,
        kind: "demonstrated-skill",
        review_kind: "observation",
        ref_id: pending.id,
        reason: "mastery claims require human review",
        state: "open",
        data: JSON.stringify({ targetScope: "workspace" }),
        created_at: now - 80000,
        resolved_at: null,
        resolved_by: null,
        content: pending.content,
        confidence: 0.7,
        evidence_type: "inferred",
        scope_kind: "session",
        target_scope: "workspace",
        session_id: sessionId,
        project_id: projectId,
        workspace,
        status: "pending_review",
        visibility: "visible",
        supersedes_id: null,
      },
      {
        id: "rev_vault",
        kind: null,
        review_kind: "vault-conflict",
        ref_id: "top_rec",
        reason: "the topic file was edited outside opencode-memory",
        state: "open",
        data: JSON.stringify({ path: "concepts/recursion.md", generation: 2 }),
        created_at: now - 40000,
        resolved_at: null,
        resolved_by: null,
        content: null,
        confidence: null,
        evidence_type: null,
        scope_kind: null,
        target_scope: null,
        session_id: null,
        project_id: null,
        workspace: null,
        status: null,
        visibility: null,
        supersedes_id: null,
      },
    ],
  },
  "/api/context": {
    ok: true,
    data: {
      latest: {
        id: "ctx_1",
        session_id: sessionId,
        request_key: "turn-9",
        agent: "build",
        model: "small",
        memory_generation: 3,
        observation_ids: [obsId],
        block,
        token_est: 2140,
        created_at: now - 60000,
      },
      snapshots: [{ id: "ctx_1", request_key: "turn-9", agent: "build", model: "small", memory_generation: 3, token_est: 2140, created_at: now - 60000 }],
    },
  },
  "/api/timeline": {
    ok: true,
    data: {
      observations: [observation, misconception, pending],
      chunks: [
        { id: "chk_1", start_seq: 1, end_seq: 20, state: "succeeded", attempts: 1, error: null, error_class: null, reason: "idle", token_est: 8000, updated_at: now - 400000 },
        { id: "chk_q", start_seq: 41, end_seq: 44, state: "quarantined", attempts: 3, error: "invalid_output", error_class: "invalid_output", reason: "idle", token_est: 2000, updated_at: now - 20000 },
      ],
      messages: [
        { id: "msg_41", seq: 41, role: "user", created_at: now - 400000, token_est: 40, status: "present" },
        { id: "msg_48", seq: 48, role: "assistant", created_at: now - 360000, token_est: 80, status: "present" },
      ],
    },
  },
  "/api/learning": {
    ok: true,
    data: {
      concepts: [
        {
          id: conceptId,
          name: "Recursion",
          slug: "recursion",
          level: "demonstrated",
          attempts: 4,
          independentCorrect: 2,
          assisted: 1,
          incorrect: 1,
          distinctDays: 2,
          openMisconceptions: 1,
          lastIndependentAt: now - 3600000,
          dueAt: now - 1000,
          approvedMastery: false,
        },
        {
          id: "con_tail",
          name: "Tail recursion",
          slug: "tail-recursion",
          level: "practicing",
          attempts: 2,
          independentCorrect: 0,
          assisted: 1,
          incorrect: 1,
          distinctDays: 1,
          openMisconceptions: 0,
          lastIndependentAt: null,
          dueAt: now + 86400000,
          approvedMastery: false,
        },
      ],
      due: [{ id: conceptId, name: "Recursion", due_at: now - 1000, reps: 2, lapses: 0 }],
      calendar: [
        { date: new Date(now).toISOString().slice(0, 10), count: 1 },
        { date: new Date(now + 86400000).toISOString().slice(0, 10), count: 1 },
      ],
    },
  },
  "/api/research": {
    ok: true,
    data: {
      claims: [
        {
          id: "claim_1",
          statement: "Tail-call optimization is required for practical recursion.",
          status: "contested",
          conditions: null,
          confidence: 0.4,
          updated_at: now,
          support: [{ id: "ev1", stance: "support", quotation: "Some languages guarantee TCO." }],
          contradict: [{ id: "ev2", stance: "contradict", quotation: "JavaScript engines do not reliably TCO." }],
        },
      ],
      conflicts: [
        {
          id: "claim_1",
          statement: "Tail-call optimization is required for practical recursion.",
          status: "contested",
          conditions: null,
          confidence: 0.4,
          updated_at: now,
          support: [{ id: "ev1", stance: "support", quotation: "Some languages guarantee TCO." }],
          contradict: [{ id: "ev2", stance: "contradict", quotation: "JavaScript engines do not reliably TCO." }],
        },
      ],
      sources: [{ id: "src_1", url: "https://example.com/tco", title: "TCO notes", doi: null, evidence_count: 2, created_at: now }],
    },
  },
  "/api/topics": {
    ok: true,
    data: [
      {
        id: "top_rec",
        scope_key: `workspace:${workspace}`,
        slug: "recursion",
        rel_path: "concepts/recursion.md",
        title: "Recursion",
        summary: "A function that calls itself with a smaller input.",
        body: "# Recursion\n\n> A function that calls itself with a smaller input.\n\n## Base cases\n\n- Every recursive definition needs a terminating case — refs: obs_recursion\n",
        generation: 2,
        state: "active",
        approved: 0,
        updated_at: now,
      },
    ],
  },
  "/api/artifacts": {
    ok: true,
    data: [
      {
        id: "art_svg",
        workspace,
        project_id: projectId,
        session_id: sessionId,
        message_id: "msg_48",
        path: "diagrams/call-stack.svg",
        kind: "svg",
        origin: "write",
        hash: "h1",
        title: "Call stack",
        concepts: "[\"Recursion\"]",
        created_at: now,
        updated_at: now,
        has_content: 1,
      },
      {
        id: "art_mmd",
        workspace,
        project_id: projectId,
        session_id: sessionId,
        message_id: "msg_48",
        path: "diagrams/map.mmd",
        kind: "mermaid",
        origin: "write",
        hash: "h2",
        title: "Concept map",
        concepts: "[\"Recursion\"]",
        created_at: now,
        updated_at: now,
        has_content: 1,
      },
    ],
  },
  "/api/operations": {
    ok: true,
    data: [
      {
        id: "op_1",
        kind: "observe",
        session_id: sessionId,
        project_id: projectId,
        ref_id: "chk_1",
        runner: "opencode-session",
        model: "small",
        status: "succeeded",
        reserved_cost: 0,
        cost: 0.01,
        input_tokens: 8000,
        output_tokens: 400,
        error: null,
        error_class: null,
        started_at: now - 200000,
        finished_at: now - 180000,
      },
    ],
  },
  "/api/jobs": {
    ok: true,
    data: [{ key: "reflect:workspace:learning", kind: "reflect", state: "idle", lease_owner: null, lease_expires_at: null, version: 2, attempts: 2, error: null, next_attempt_at: null, updated_at: now }],
  },
  "/api/backups": {
    ok: true,
    data: [
      { file: "memory-20260102-090000.db", size: 8_192, createdAt: now - 3_600_000 },
      { file: "memory-20260101-180000.db", size: 0, createdAt: now - 50_000_000 },
      { file: "memory-20260101-120000.db", size: 12_000, createdAt: now - 86400000 },
    ],
  },
  "/api/export": { ok: true, data: { observations: [observation], exportedAt: now } },
}

function ok(data) {
  return { ok: true, data }
}

const resolvedReviews = new Set()
const forgotten = new Set()
const UNMARKED_BACKUP = "memory-20260102-090000.db"
const EMPTY_BACKUP = "memory-20260101-180000.db"
const MIN_TIMER_MS = 1000
const TIMER_KEYS = [
  ["runner", "timeoutMs"],
  ["reflectorRunner", "timeoutMs"],
  ["observe", "leaseMs"],
]
// MOCK_CONFIG=broken: config.json on disk is not valid JSON, so every save is refused with 400 (core saveConfigPatch).
const MOCK_CONFIG = process.env.MOCK_CONFIG || ""

/** core util.ts INSTRUCTION_PATTERN. */
const INSTRUCTION_PATTERN =
  /\b(ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|messages)|disregard (all |any )?(previous |prior )?instructions|(you|the assistant) (must|should|shall) (always|never)|system prompt|from now on,? (you|the assistant)|always respond with|new instructions?:)/i
const INSTRUCTION_REFUSED =
  "instruction-like content is not stored from the agent (it could steer future sessions); the user can add it from the Memory dashboard"

/** core sessionWriteBlock: why nothing may be written into this session (its WriteFailure is 409). */
function sessionWriteBlock(session) {
  if (session !== sessionId) return undefined
  if (status.session.forgotten) return "this session was forgotten; nothing more is stored from it"
  if (status.session.excluded) return "this session is excluded from memory; memories cannot be written to it"
  return undefined
}

function setSessionRow(fields) {
  Object.assign(status.session, fields)
  const row = payload["/api/sessions"].data.find((s) => s.id === sessionId)
  if (!row) return
  if ("excluded" in fields) row.excluded = fields.excluded ? 1 : 0
  if ("paused" in fields) row.paused = fields.paused ? 1 : 0
  if ("title" in fields) row.title = fields.title
}

function rowById(id) {
  const row = rows.find((o) => o.id === id)
  return row && forgotten.has(id) ? { ...row, status: "forgotten" } : row
}

/** http.ts dashCtx: the session's context, else the named project, else the first local project. */
function dashCtx(session, project) {
  if (session === sessionId) return { projectId, workspace, sessionId }
  if (project) return { projectId: project, workspace: project === projectId ? workspace : "unknown", sessionId: session || undefined }
  return { projectId, workspace, sessionId: session || undefined }
}

/** core forget.ts inForgetScope. */
function inForgetScope(ctx, row) {
  if (row.visibility !== "visible") return false
  if (row.status === "pending_review") return !!ctx.sessionId && row.session_id === ctx.sessionId
  if (!["active", "superseded", "expired"].includes(row.status)) return false
  if (row.scope_kind === "session" || row.scope_kind === "project") return row.project_id === ctx.projectId
  if (row.scope_kind === "workspace") return row.workspace === ctx.workspace
  return row.scope_kind === "user"
}

function words(text) {
  return new Set(String(text).toLowerCase().split(/\W+/).filter(Boolean))
}

function jaccard(a, b) {
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both ? both / (a.size + b.size - both) : 0
}

// MOCK_FLUSH=local (default) | noowner (409) | routed | fail | expire; routed commands advance one state per GET /api/commands/:id.
const MOCK_FLUSH = process.env.MOCK_FLUSH || "local"
const commands = new Map()
let nextCommandId = 1
const FLUSH_RESULT = { chunks: ["chk_2"], outcomes: [], waited: false }

function advanceCommand(cmd) {
  const steps =
    cmd.mode === "expire" ? ["pending", "pending", "expired"] : cmd.mode === "fail" ? ["pending", "running", "failed"] : ["pending", "running", "done"]
  cmd.polls++
  cmd.state = steps[Math.min(cmd.polls, steps.length - 1)]
  if (cmd.state === "running") cmd.attempts = 1
  if (cmd.state === "done") cmd.result = JSON.stringify(FLUSH_RESULT)
  if (cmd.state === "failed") cmd.result = JSON.stringify({ error: "Error: runner timed out" })
  cmd.updated_at = Date.now()
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v
  return out
}

function recallMessage(seq) {
  const role = seq % 2 ? "user" : "assistant"
  return {
    id: `msg_${seq}`,
    seq,
    role,
    agent: role === "assistant" ? "build" : null,
    createdAt: now - 900_000 + seq * 1000,
    status: "present",
    parts: [{ id: `p_${seq}`, type: "text", tool: null, text: `Tail recursion drill, step ${seq}.`, redactions: 0, omitted: 0, forgotten: false }],
  }
}

const RECALL_CAP = 40
const LONG_RANGE = [1, 55]

/** engine.recallSource padding: `context` clamped to 0..10, default 1. */
function recallPad(raw) {
  const n = raw == null || raw === "" ? 1 : Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.floor(n))) : 1
}

/**
 * Mirrors the engine: at most RECALL_CAP messages, then `truncated` with a cursor for the rest.
 * Observation cursors keep the original padding and observation id; session cursors carry context 0.
 */
function rangeRecall(from, to, observationId, pad = 0) {
  const all = []
  for (let s = Math.max(from, LONG_RANGE[0]); s <= Math.min(to, LONG_RANGE[1]); s++) all.push(recallMessage(s))
  const messages = all.slice(0, RECALL_CAP)
  const rest = all[RECALL_CAP]
  return {
    ok: true,
    guarantee: rest ? "exact recall of retained, redacted source content (truncated)" : "exact recall of retained, redacted source content",
    sessionId,
    fromSeq: from,
    toSeq: messages[messages.length - 1]?.seq ?? to,
    messages,
    cited: [[from, to]],
    truncated: !!rest,
    nextCursor: rest
      ? observationId
        ? { sessionId, fromSeq: rest.seq, toSeq: to, context: pad, observationId }
        : { sessionId, fromSeq: rest.seq, toSeq: to, context: 0 }
      : undefined,
  }
}

function observationDetail(id) {
  const row = rowById(id) || observation
  return ok({
    ...row,
    payload: row.payload,
    sources: [
      {
        observation_id: row.id,
        session_id: sessionId,
        start_message_id: "msg_41",
        end_message_id: "msg_48",
        start_seq: 41,
        end_seq: 48,
        part_ids: [],
        transform_version: 1,
      },
    ],
    events: [{ type: "created", actor: "observer", at: row.observed_at, data: null }],
    reviews: payload["/api/review"].data.filter((r) => r.ref_id === row.id),
  })
}

function mime(file) {
  switch (extname(file)) {
    case ".html":
      return "text/html; charset=utf-8"
    case ".js":
      return "text/javascript; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".json":
      return "application/json"
    case ".svg":
      return "image/svg+xml"
    case ".woff2":
      return "font/woff2"
    default:
      return "application/octet-stream"
  }
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

function injectMeta(html) {
  const tags = `<meta name="om-token" content="${escapeAttr(token)}" />\n<meta name="om-config" content="${escapeAttr(JSON.stringify(config))}" />`
  if (html.includes("</head>")) return html.replace("</head>", `${tags}\n</head>`)
  return tags + html
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "frame-ancestors 'self' oc://renderer",
].join("; ")

function hostAllowed(req) {
  const h = String(req.headers.host || "")
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`
}

function redactHeaders(value) {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(redactHeaders)
  const out = { ...value }
  if (out.headers && typeof out.headers === "object") {
    const headers = {}
    for (const k of Object.keys(out.headers)) headers[k] = "***"
    out.headers = headers
  }
  for (const [k, v] of Object.entries(out)) {
    if (v && typeof v === "object" && k !== "headers") out[k] = redactHeaders(v)
  }
  return out
}

const SENSITIVE_KEYS = new Set(["allowedOrigins", "port", "dataDir", "vaultDir", "baseURL", "apiKeyEnv", "headers", "dir"])

function stripSensitive(value) {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stripSensitive)
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k)) continue
    out[k] = stripSensitive(v)
  }
  return out
}

function send(res, statusCode, body, type = "application/json; charset=utf-8") {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body))
  res.writeHead(statusCode, {
    "content-type": type,
    "content-length": buf.length,
    "cache-control": "no-store",
    "content-security-policy": CSP,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })
  res.end(buf)
}

function safeFile(urlPath) {
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "")
  const abs = normalize(join(dist, rel))
  if (!abs.startsWith(normalize(dist) + sep) && abs !== normalize(dist)) return null
  return abs
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`)
  const path = url.pathname
  try {
    if (!hostAllowed(req)) return send(res, 403, { ok: false, error: "invalid host" })

    if (path === "/health") return send(res, 200, payload["/health"])

    if (path.startsWith("/api/")) {
      const got = req.headers["x-om-token"]
      if (got !== token) return send(res, 401, { ok: false, error: "unauthorized" })

      if (req.method === "POST") {
        const body = await readBody(req)
        const needConfirm = () => {
          if (body.confirm === true) return true
          send(res, 400, { ok: false, error: "destructive action requires confirm: true" })
          return false
        }
        if (path === "/api/forget") {
          if (!needConfirm()) return
          const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string" && x.trim()) : []
          if (!ids.length) return send(res, 400, { ok: false, error: "ids required" })
          const purge = body.purgeSources ?? "none"
          if (purge !== "none" && purge !== "sources") return send(res, 400, { ok: false, error: "purgeSources must be sources or none" })
          // Naming a known session only admits ids in its forget scope (the rest are skipped); the dashboard never does.
          const ctx = typeof body.session === "string" && body.session === sessionId ? dashCtx(body.session) : undefined
          const skipped = ctx ? ids.filter((id) => !rowById(id) || !inForgetScope(ctx, rowById(id))) : []
          const observationIds = ids.filter((id) => !skipped.includes(id) && rowById(id) && rowById(id).status !== "forgotten")
          if (!observationIds.length) return send(res, 404, { ok: false, error: skipped.length ? "not found in this session's scope" : "not found" })
          for (const id of observationIds) forgotten.add(id)
          const reactivated = observationIds.includes("obs_mis") ? ["obs_recursion"] : undefined
          return send(
            res,
            200,
            ok({
              observationIds,
              partsPurged: purge === "sources" ? 2 : 0,
              topicsTouched: [],
              snapshotsPurged: 0,
              ...(reactivated ? { reactivated } : {}),
              scrubPending: true,
              skipped,
            }),
          )
        }
        if (path === "/api/forget/candidates") {
          // http.ts admitCtx: scoped only when a known session or a project is named; the dashboard names neither.
          const text = String(body.text ?? "")
          const session = typeof body.session === "string" && body.session ? body.session : undefined
          const ctx = session ? (session === sessionId ? dashCtx(session) : undefined) : body.project ? dashCtx(undefined, String(body.project)) : undefined
          const target = words(text)
          const needle = text.toLowerCase()
          const found = rows
            .map((r) => rowById(r.id))
            .filter((r) => ["active", "pending_review", "superseded", "expired"].includes(r.status) && (!ctx || inForgetScope(ctx, r)))
            .map((r) => ({ id: r.id, content: r.content, score: jaccard(target, words(r.content)) }))
            .filter((r) => r.score >= 0.2 || r.content.toLowerCase().includes(needle))
            .sort((a, b) => b.score - a.score)
          return send(res, 200, ok(found))
        }
        if (path === "/api/forget/session") {
          if (!needConfirm()) return
          // core forgetSession: the session is excluded (and untitled) for good.
          setSessionRow({ forgotten: true, excluded: true, title: null })
          return send(res, 200, ok({ observationIds: [obsId], partsPurged: 2, topicsTouched: ["top_rec"], snapshotsPurged: 1 }))
        }
        const flagsMatch = /^\/api\/sessions\/([^/]+)\/flags$/.exec(path)
        if (flagsMatch) {
          const id = decodeURIComponent(flagsMatch[1])
          const flags = ["excluded", "paused"].filter((f) => body[f] !== undefined)
          if (!flags.length) return send(res, 400, { ok: false, error: "paused or excluded required" })
          const bad = flags.find((f) => typeof body[f] !== "boolean")
          if (bad) return send(res, 400, { ok: false, error: `${bad} must be a boolean` })
          if (id !== sessionId) return send(res, 404, { ok: false, error: "not found" })
          // core setSessionFlag: a forgotten session stays excluded (MemoryError 409), and nothing else changes.
          if (body.excluded === false && status.session.forgotten) {
            return send(res, 409, { ok: false, error: "this session was forgotten and cannot be included in memory again" })
          }
          setSessionRow(Object.fromEntries(flags.map((f) => [f, body[f]])))
          return send(res, 200, ok({ done: true }))
        }
        if (path === "/api/redact-test") {
          const text = String(body.text || "").replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED:openai-key]")
          return send(res, 200, ok({ text, count: text.includes("REDACTED") ? 1 : 0, rules: text.includes("REDACTED") ? ["openai-key"] : [] }))
        }
        if (path === "/api/backups") return send(res, 200, ok({ file: "memory-mock.db" }))
        if (path === "/api/backups/restore") {
          if (!needConfirm()) return
          const known = payload["/api/backups"].data.some((b) => b.file === body.file)
          if (!known) return send(res, 400, { ok: false, error: "unknown backup" })
          // core restoreBackup refusals (force is never exposed over HTTP): empty file 400, then unmarked 409.
          if (body.file === EMPTY_BACKUP) return send(res, 400, { ok: false, error: "backup file is missing or empty" })
          if (body.file === UNMARKED_BACKUP) return send(res, 409, { ok: false, error: "refusing to restore: the file has no backup marker" })
          return send(res, 200, ok({ tables: 12 }))
        }
        if (path === "/api/config") {
          if (!isObj(body.patch)) return send(res, 400, { ok: false, error: "patch required" })
          const patch = stripSensitive(body.patch)
          for (const [section, field] of TIMER_KEYS) {
            const v = isObj(patch[section]) ? patch[section][field] : undefined
            if (v === undefined) continue
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return send(res, 400, { ok: false, error: `${section}.${field} must be a non-negative number` })
            if (v < MIN_TIMER_MS) return send(res, 400, { ok: false, error: `${section}.${field} must be at least ${MIN_TIMER_MS} ms` })
          }
          if (MOCK_CONFIG === "broken") {
            return send(res, 400, { ok: false, error: "config.json is not valid JSON; fix or remove it before saving settings" })
          }
          for (const [section, value] of Object.entries(patch)) {
            memoryConfig[section] = isObj(value) && isObj(memoryConfig[section]) ? deepMerge(memoryConfig[section], value) : value
          }
          return send(res, 200, ok(redactHeaders(memoryConfig)))
        }
        if (path === "/api/pause") {
          if (typeof body.paused !== "boolean") return send(res, 400, { ok: false, error: "paused must be a boolean" })
          if (body.untilMs !== undefined && (typeof body.untilMs !== "number" || !Number.isFinite(body.untilMs))) {
            return send(res, 400, { ok: false, error: "untilMs must be a number" })
          }
          // engine.setPaused: pausedReason is "manual" while paused by the user, null once resumed.
          status.global.paused = body.paused
          status.global.pausedReason = body.paused ? "manual" : null
          return send(res, 200, ok({ done: true }))
        }
        if (path === "/api/flush") {
          const session = typeof body.session === "string" ? body.session : ""
          if (!session) return send(res, 400, { ok: false, error: "session required" })
          if (session !== sessionId) return send(res, 404, { ok: false, error: "not found" })
          if (MOCK_FLUSH === "noowner") return send(res, 409, { ok: false, error: "No OpenCode window owns this project" })
          if (MOCK_FLUSH === "local") return send(res, 200, ok({ routed: false, result: FLUSH_RESULT }))
          const id = nextCommandId++
          const at = Date.now()
          commands.set(id, { id, kind: "flush", state: "pending", result: null, attempts: 0, created_at: at, updated_at: at, polls: 0, mode: MOCK_FLUSH })
          return send(res, 200, ok({ routed: true, commandId: id, state: "pending" }))
        }
        if (path === "/api/remember") {
          const content = String(body.content || "")
          if (!content.trim()) return send(res, 400, { ok: false, error: "content required" })
          if (body.payload !== undefined && body.payload !== null && !isObj(body.payload)) return send(res, 400, { ok: false, error: "payload must be an object" })
          // core refuses instruction-like text only from the agent (memory_remember); the mock also refuses it here so
          // the dashboard's inline 400 can be exercised.
          if (INSTRUCTION_PATTERN.test(content)) return send(res, 400, { ok: false, error: INSTRUCTION_REFUSED })
          const blocked = sessionWriteBlock(typeof body.session === "string" ? body.session : undefined)
          if (blocked) return send(res, 409, { ok: false, error: blocked })
          return send(res, 200, ok({ id: "obs_remembered", status: "active", scope: body.scope || "session" }))
        }
        if (path === "/api/chunks/retry-quarantined") return send(res, 200, ok({ n: 1 }))
        if (path.startsWith("/api/review/")) {
          const id = decodeURIComponent(path.slice("/api/review/".length))
          if (body.decision !== "approve" && body.decision !== "reject") {
            return send(res, 400, { ok: false, error: "decision must be approve or reject" })
          }
          const known = payload["/api/review"].data.some((r) => r.id === id)
          if (!known) return send(res, 404, { ok: false, error: "not found" })
          if (resolvedReviews.has(id)) return send(res, 409, { ok: false, error: "already resolved" })
          resolvedReviews.add(id)
          return send(res, 200, ok({ done: true }))
        }
        const supMatch = /^\/api\/observations\/([^/]+)\/supersede$/.exec(path)
        if (supMatch) {
          const content = typeof body.content === "string" ? body.content.trim() : ""
          if (!content) return send(res, 400, { ok: false, error: "content required" })
          const row = rowById(decodeURIComponent(supMatch[1]))
          if (!row) return send(res, 404, { ok: false, error: "observation not found" })
          if (INSTRUCTION_PATTERN.test(content)) return send(res, 400, { ok: false, error: INSTRUCTION_REFUSED })
          // engine.supersede: the view's session (none from the dashboard), else the row's session when it was forgotten.
          const blocked =
            sessionWriteBlock(typeof body.session === "string" ? body.session : undefined) ??
            (row.session_id === sessionId && status.session.forgotten ? sessionWriteBlock(row.session_id) : undefined)
          if (blocked) return send(res, 409, { ok: false, error: blocked })
          return send(res, 200, ok({ id: "obs_new", status: "active", scope: "session" }))
        }
        return send(res, 200, ok({ done: true }))
      }

      if (path === "/api/status") return send(res, 200, payload["/api/status"])
      if (path === "/api/config") return send(res, 200, ok(redactHeaders(memoryConfig)))
      if (path === "/api/projects") return send(res, 200, payload["/api/projects"])
      if (path === "/api/workspaces") return send(res, 200, payload["/api/workspaces"])
      if (path === "/api/sessions") return send(res, 200, payload["/api/sessions"])
      if (path === "/api/review") {
        const session = url.searchParams.get("session")
        const state = url.searchParams.get("state") || "open"
        let items = payload["/api/review"].data
        if (state === "open") items = items.filter((r) => !resolvedReviews.has(r.id))
        if (session) {
          // http.ts reviewItemsFor: unknown session -> []; otherwise rows readable from the session's project,
          // plus vault conflicts on topics in its workspace/project.
          if (session !== sessionId) return send(res, 200, ok([]))
          const topicScope = new Set(payload["/api/topics"].data.filter((t) => t.scope_key === `workspace:${workspace}` || t.scope_key === `project:${projectId}`).map((t) => t.id))
          items = items.filter((r) => (r.review_kind === "vault-conflict" ? topicScope.has(r.ref_id) : r.project_id === projectId))
        }
        return send(res, 200, ok(items))
      }
      if (path.startsWith("/api/commands/")) {
        const id = Number(path.slice("/api/commands/".length))
        const cmd = Number.isFinite(id) ? commands.get(id) : undefined
        if (!cmd) return send(res, 404, { ok: false, error: "not found" })
        advanceCommand(cmd)
        const { polls, mode, ...row } = cmd
        // http.ts parses the stored JSON text before sending it.
        return send(res, 200, ok({ ...row, result: row.result ? JSON.parse(row.result) : null }))
      }
      if (path === "/api/context") return send(res, 200, payload["/api/context"])
      if (path === "/api/timeline") {
        const t = payload["/api/timeline"].data
        return send(res, 200, ok({ ...t, observations: t.observations.filter((o) => !forgotten.has(o.id)) }))
      }
      if (path === "/api/learning") return send(res, 200, payload["/api/learning"])
      if (path === "/api/research") return send(res, 200, payload["/api/research"])
      if (path === "/api/topics") return send(res, 200, payload["/api/topics"])
      if (path === "/api/artifacts") return send(res, 200, payload["/api/artifacts"])
      if (path === "/api/operations") return send(res, 200, payload["/api/operations"])
      if (path === "/api/jobs") return send(res, 200, payload["/api/jobs"])
      if (path === "/api/backups") return send(res, 200, payload["/api/backups"])
      if (path === "/api/export") return send(res, 200, payload["/api/export"])
      if (path === "/api/search") {
        const q = (url.searchParams.get("q") || "").toLowerCase()
        const rows = [observation, misconception, pending].filter((o) => !forgotten.has(o.id) && (!q || o.content.toLowerCase().includes(q)))
        return send(res, 200, ok(rows.map((row) => ({ row, score: 1.2, text: 1.2, vector: 0 }))))
      }
      if (path === "/api/recall") {
        const observationId = url.searchParams.get("observation")
        const recallSession = url.searchParams.get("session")
        const from = Number(url.searchParams.get("from") || 0)
        const to = Number(url.searchParams.get("to") || 0)
        // Recall reads through dashCtx, so a row from another project needs its session or project named.
        const ctx = dashCtx(recallSession || undefined, url.searchParams.get("project") || undefined)
        const cited = observationId ? rowById(observationId) : undefined
        const readable = cited && cited.status !== "forgotten" && (cited.scope_kind === "workspace" || cited.project_id === ctx.projectId)
        if (observationId && !readable) {
          return send(res, 404, { ok: false, error: "observation not found or not readable from this project" })
        }
        const pad = recallPad(url.searchParams.get("context"))
        if (observationId === FOREIGN_ID) return send(res, 200, ok({ ...rangeRecall(1, 4), sessionId: foreign.session_id }))
        // obs_mis cites a long stretch of conversation so the dashboard's "Load more" path is exercised; its
        // cursor carries the padding and observation id the dashboard must send back unchanged.
        if (observationId === "obs_mis") {
          const end = LONG_RANGE[1] + pad
          return send(res, 200, ok(from ? rangeRecall(from, to || end, observationId, pad) : rangeRecall(Math.max(1, LONG_RANGE[0] - pad), end, observationId, pad)))
        }
        if (!observationId && recallSession) {
          if (recallSession !== sessionId) return send(res, 404, { ok: false, error: "that session is not readable from this project" })
          const lo = from || 1
          return send(res, 200, ok(rangeRecall(Math.max(1, lo - pad), (to || lo) + pad)))
        }
        return send(
          res,
          200,
          ok({
            ok: true,
            guarantee: "exact recall of retained, redacted source content",
            sessionId,
            fromSeq: 41,
            toSeq: 48,
            cited: [[41, 48]],
            messages: [
              {
                id: "msg_41",
                seq: 41,
                role: "user",
                agent: null,
                createdAt: now - 400000,
                status: "present",
                parts: [{ id: "p1", type: "text", tool: null, text: "Help me practice recursion.", redactions: 0, omitted: 0, forgotten: false }],
              },
              {
                id: "msg_48",
                seq: 48,
                role: "assistant",
                agent: "build",
                createdAt: now - 360000,
                status: "present",
                parts: [
                  { id: "p2", type: "text", tool: null, text: "Here is a base-case drill.", redactions: 1, omitted: 0, forgotten: false },
                  { id: "p3", type: "text", tool: null, text: "[forgotten note]", redactions: 0, omitted: 0, forgotten: true },
                ],
              },
            ],
          }),
        )
      }
      if (path === "/api/observations") {
        const kinds = url.searchParams.get("kinds")
        const rows = [observation, misconception, pending].filter((o) => !kinds || kinds.split(",").includes(o.kind))
        return send(res, 200, ok(rows))
      }
      if (path.startsWith("/api/observations/")) return send(res, 200, observationDetail(path.slice("/api/observations/".length)))
      if (path.startsWith("/api/topics/")) {
        const t = payload["/api/topics"].data[0]
        return send(res, 200, ok({ ...t, generations: [{ topic_id: t.id, generation: 1, title: t.title, hash: "g1", actor: "reflector", created_at: now - 86400000 }] }))
      }
      if (path.startsWith("/api/artifacts/")) {
        const id = path.slice("/api/artifacts/".length)
        if (id === "art_mmd") {
          return send(res, 200, ok({ id, kind: "mermaid", title: "Concept map", path: "diagrams/map.mmd", content: "flowchart LR\n  A[Recursion] --> B[Base case]" }))
        }
        return send(
          res,
          200,
          ok({
            id,
            kind: "svg",
            title: "Call stack",
            path: "diagrams/call-stack.svg",
            content: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#ddd"/><text x="10" y="40">stack</text></svg>`,
          }),
        )
      }
      return send(res, 404, { ok: false, error: "not found" })
    }

    if (path === "/") {
      res.writeHead(302, { location: "/app" })
      return res.end()
    }

    let file = safeFile(path)
    if (file && existsSync(file) && statSync(file).isFile()) {
      const body = readFileSync(file)
      if (extname(file) === ".html") return send(res, 200, injectMeta(body.toString("utf8")), mime(file))
      res.writeHead(200, {
        "content-type": mime(file),
        "content-length": body.length,
        "content-security-policy": CSP,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      })
      return res.end(body)
    }

    if (path === "/embed" || path === "/app" || path.startsWith("/app/")) {
      const index = join(dist, "index.html")
      if (!existsSync(index)) return send(res, 500, { ok: false, error: "dashboard dist missing; run bun run build" })
      return send(res, 200, injectMeta(readFileSync(index, "utf8")), "text/html; charset=utf-8")
    }

    send(res, 404, { ok: false, error: "not found" })
  } catch (e) {
    send(res, 500, { ok: false, error: String(e) })
  }
})

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock memory dashboard on http://127.0.0.1:${port}\n`)
})
