/**
 * Shared contract between the plugin's local HTTP server, the dashboard SPA,
 * and the OpenCode desktop fork's Memory tab. Type-only consumers (dashboard,
 * fork) may copy these definitions; the plugin and dashboard import them.
 *
 * HTTP server (plugin):
 * - Binds 127.0.0.1:<config.port> only. First process to bind serves; others share the DB.
 * - Every request: Host must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard).
 * - Origin, when present, must be the server's own origin or in config.allowedOrigins.
 *   `Sec-Fetch-Site: cross-site` from a non-allowed origin is rejected, except GET page
 *   navigations (`Sec-Fetch-Mode: navigate` to /app, /app/*, /embed), which carry no Origin
 *   and are protected by CSP `frame-ancestors` instead. /api, /health and /assets never get
 *   that exemption.
 * - /api/* requires header `X-OM-Token: <token>`. The token lives in <dataDir>/token
 *   (created on first start) and is embedded into served HTML as <meta name="om-token">.
 *   Cross-origin pages cannot read that HTML, and the custom header forces a preflight
 *   that the server never approves (no Access-Control-Allow-* on /api).
 * - Mutations are POST with `Content-Type: application/json` and a JSON object body (anything
 *   else, including null/array/number bodies, is 400); destructive ones need `confirm: true`.
 *   Bodies over 1 MB get 400 `payload too large` with `Connection: close`.
 * - HTML responses carry CSP `frame-ancestors 'self' <allowedOrigins>` plus a strict default-src,
 *   `Referrer-Policy: no-referrer` and `Cache-Control: no-store` (they embed the token).
 * - Config over HTTP is untrusted: GET /api/config masks header values; POST /api/config
 *   ignores allowedOrigins, port, dataDir, vault/backup dirs and runner/embedding
 *   baseURL/apiKeyEnv/headers, both in memory and when persisting.
 * - /health is unauthenticated, returns no user data, and sends ACAO for allowed origins only
 *   (so the desktop renderer can probe it).
 */

export const API_VERSION = 1
export const BRIDGE_VERSION = 1
export const TOKEN_HEADER = "x-om-token"
export const TOKEN_META = "om-token"
export const CONFIG_META = "om-config"

/** JSON placed in <meta name="om-config" content="..."> of served HTML. */
export type ServedConfig = { port: number; allowedOrigins: string[]; version: string }

export type HealthResponse = { ok: true; name: "opencode-memory"; version: string; api: number }

/**
 * Routes. Query params in `?a=&b=`; lists are comma-separated. All responses are JSON
 * `{ ok: true, data }` or `{ ok: false, error }` with a matching HTTP status: 400 invalid
 * input, 401 token, 403 host/origin, 404 unknown id, 409 already resolved or conflicting
 * state, 500 unexpected (generic message, no paths or SQL). A mutation that did nothing
 * is an error, never `{ ok: true }`. Engine results shaped `{ ok: false, error }` are
 * surfaced as 4xx errors, not wrapped in `data`.
 *
 * Mutation result shapes: review decide, pin, edit, topic approve/rollback, chunk retry,
 * pause, flags -> `{ done: true }`; retry-quarantined -> `{ n }`; POST /api/backups -> `{ file }`;
 * remember/supersede -> `{ id, status, scope }`; forget, forget/session -> ForgetResult (below)
 * with `skipped` always present; POST /api/config -> the new config, masked like GET.
 * Error messages never carry absolute filesystem paths (only the file name is kept).
 *
 * Write failures (remember/supersede, and the memory_remember / memory_supersede tools): the
 * engine's `WriteFailure.status` is the HTTP status, with the engine's message as `error`:
 * - 400: empty content; `payload` not an object or invalid for the kind (`invalid payload
 *   <field>: …`); instruction-like text written by the AGENT (dashboard writes are the user's
 *   and are not refused for that).
 * - 403: the agent replacing a workspace/user memory. 404: unknown or unreadable observation.
 * - 409: text that was forgotten earlier; a forgotten, excluded or deleted session (the
 *   request's `session`, or for supersede also the row's own session once forgotten); the
 *   agent superseding a pending-review row.
 * `payload` on remember is optional, validated per kind, and sets the subject key.
 *
 * ForgetResult: `observationIds` forgotten; `partsPurged` source parts blanked; `topicsTouched`;
 * `snapshotsPurged`; `skipped` ids outside the admitting session's scope (not touched);
 * `reactivated` sources of a forgotten condensed summary that are current again;
 * `backupsScrubbed` / `backupsFailed` counts (only when the scrub was awaited);
 * `scrubPending` true while backups still hold the content (background scrub, retried).
 *
 * Forget over HTTP is always a USER forget and GLOBAL: rows and suppressions are removed
 * everywhere, not just inside a session's boundary. `session` (or `project`) on /api/forget and
 * /api/forget/candidates only ADMITS ids/candidates readable from that view; ids outside it come
 * back in `skipped`. The agent's memory_forget tool is the scoped (ctx) forget.
 * /api/forget -> 404 when nothing was forgotten. /api/forget/session also excludes the session
 * and suppresses it for good; 404 if unknown, or already forgotten with nothing left to remove.
 * POST /api/sessions/:id/flags needs at least one boolean of `paused` / `excluded` (else 400);
 * `excluded: false` on a forgotten session is 409 (engine MemoryError 'forgotten') and nothing
 * in that request is applied: a forgotten session stays excluded for good.
 *
 * Status (`global`): `pausedReason` is 'manual' (user pause, maybe with untilMs), 'auth'
 * (runner credentials failed; resumes after a fix), or another short machine reason; null
 * when not paused. `reflecting` is boolean. `lastFailureAt` / `lastSuccessAt` are epoch ms
 * of the latest failed / succeeded operation, or null.
 * Status (`session`): `forgotten` is true once the session was forgotten (it is then also
 * `excluded`); clients should not offer to include it again.
 *
 * Recall (GET /api/recall and the memory_recall_source tool): a part carries `truncated: true`
 * when its text was cut to fit the recall budget (the text then holds an omitted-chars marker).
 * `nextCursor` is a RecallCursor `{ sessionId, fromSeq, toSeq, context, observationId? }` to
 * pass back unchanged (context is 0 for session cursors; observation cursors keep the original
 * padding and `observationId`); the tool accepts and prints the full cursor. Over HTTP the next
 * page is `?observation=<observationId>&from=<fromSeq>&to=<toSeq>&context=<context>` (or
 * `?session=<sessionId>&…` without an observationId); changing `context` or dropping
 * `observationId` reads a different range.
 *
 * Memory block: the injected system-prompt block opens with `<opencode-memory hash="…">`, a
 * 12-hex-char hash of the block body (replacing the old `generation="N"`); the same body always
 * gives the same hash. Readers should match the tag, not a fixed attribute.
 *
 * Config (POST /api/config): `runner.timeoutMs`, `reflectorRunner.timeoutMs` and
 * `observe.leaseMs` must be numbers of at least 1000 ms (core MIN_TIMER_MS), else 400
 * `<key> must be at least 1000 ms`. The save is also 400 when config.json is not valid JSON or
 * not an object, or a patched section would still be invalid (fix the file first); nothing is
 * changed then. Sections the patch does not touch (unknown or invalid ones included) are kept.
 *
 * Restore (POST /api/backups/restore): 400 for an unknown backup or a missing/empty file.
 * A file that is not an opencode-memory backup, has an unsupported/newer schema, lacks the
 * backup marker, or has no sessions, observations or topics returns 409. A refused restore
 * leaves the live database untouched.
 *
 * Review rows (GET /api/review): `review_kind` is the review item type ('observation',
 * 'promotion', 'vault-conflict', 'source-reverted') and `reason` says why; the joined
 * observation's own kind is `kind` (null when the item does not refer to an observation).
 *
 * Commands: POST /api/flush and /api/reflect run locally when this process owns the project,
 * else are queued for the live OpenCode window that does -> `{ routed, commandId, state }`;
 * 409 `No OpenCode window owns this project` when no live instance (heartbeat < 120s) owns
 * it. GET /api/commands/:id -> `{ id, kind, state, result, attempts, created_at, updated_at }`
 * where state is pending (queued) | running (claimed, leased) | done | failed | expired
 * (pending over 1h, never claimed) and `result` is the parsed JSON result (failed:
 * `{ error }`), or null.
 *
 * Pages:  GET /  -> 302 /app ;  GET /app, /app/*, /embed  -> SPA index.html ;  GET /assets/* -> static
 * GET  /health
 * GET  /api/status?session=                      { global, session? }
 * GET  /api/projects | /api/workspaces
 * GET  /api/sessions?project=&limit=
 * GET  /api/observations?session=&project=&workspace=&scope=&kinds=&evidence=&statuses=&q=&before=&limit=
 * GET  /api/observations/:id                     observation with sources, events, reviews
 * GET  /api/search?q=&session=&project=&scopes=&kinds=&history=1&limit=
 * GET  /api/recall?observation=&context=  |  ?session=&from=&to=&context=
 * GET  /api/timeline?session=
 * GET  /api/context?session=                     { latest, snapshots }
 * GET  /api/review?state=open&session=            session narrows to items readable from it
 * POST /api/review/:id                           { decision: "approve"|"reject" (required), content? }
 * POST /api/observations/:id/pin                 { pinned }
 * POST /api/observations/:id/edit                { content }
 * POST /api/observations/:id/supersede           { content, reason }
 * POST /api/remember                             { content, kind?, scope, session?, project?, payload? }
 * POST /api/forget                               { ids, purgeSources?: "sources"|"none" (default "none"), reason?, session?, confirm: true }
 * POST /api/forget/candidates                    { text, session? }
 * POST /api/forget/session                       { session, confirm: true }
 * POST /api/flush                                { session }
 * POST /api/reflect                              { scopeKey }
 * POST /api/pause                                { paused, untilMs? }
 * POST /api/sessions/:id/flags                   { paused?, excluded? }
 * POST /api/chunks/:id/retry  |  POST /api/chunks/retry-quarantined { session? }
 * GET  /api/operations?limit=  |  GET /api/jobs  |  GET /api/commands/:id
 * GET  /api/topics?scope=  |  GET /api/topics/:id
 * POST /api/topics/:id/approve  |  POST /api/topics/:id/rollback { generation }
 * GET  /api/learning?workspace=  |  GET /api/research?workspace=
 * GET  /api/artifacts?workspace=&project=  |  GET /api/artifacts/:id
 * GET  /api/backups  |  POST /api/backups  |  POST /api/backups/restore { file, confirm: true }
 * GET  /api/export?workspace=
 * GET  /api/config  |  POST /api/config { patch }
 * POST /api/redact-test                          { text }
 */
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string }

/** Status pill states shown by the tab and dashboard. */
export type MemoryState = "idle" | "buffering" | "observing" | "reflecting" | "paused" | "error"

/**
 * Host <-> embed bridge (window.postMessage). Both sides check `event.source` and
 * `event.origin` and always post to an exact target origin, never "*".
 *
 * Embed (dashboard at /embed) discovers the host origin from the `hostOrigin` query param
 * (primary; the host always sets it) or `location.ancestorOrigins[0]`, accepting it only if
 * listed in ServedConfig.allowedOrigins.
 * Host (fork Memory tab) accepts messages only from its iframe's contentWindow whose origin
 * equals the configured dashboard origin, which must be loopback http(s) (127.0.0.1,
 * localhost, [::1]) on any port.
 *
 * Handshake: embed sends om:ready; host answers with om:context and re-sends it whenever
 * any field changes. The host never reloads the iframe for context changes.
 *
 * Host handling: om:navigate may carry any message id of the session; the host maps
 * assistant messages to their parent user message and resolves the session's directory
 * itself. om:insert appends to the composer (never replaces the draft, never submits),
 * capped at 16k chars. om:open-dashboard paths must be `/app` or start with `/app/`, and
 * are throttled. om:status reviewCount is clamped to a non-negative integer.
 */
export type EmbedToHost =
  | { source: "opencode-memory"; v: 1; type: "om:ready" }
  | { source: "opencode-memory"; v: 1; type: "om:navigate"; sessionID: string; messageID: string }
  | { source: "opencode-memory"; v: 1; type: "om:insert"; text: string }
  | { source: "opencode-memory"; v: 1; type: "om:status"; state: MemoryState; reviewCount: number }
  | { source: "opencode-memory"; v: 1; type: "om:open-dashboard"; path?: string }

export type HostToEmbed = {
  source: "opencode-memory-host"
  v: 1
  type: "om:context"
  sessionID?: string
  directory?: string
  theme: "light" | "dark"
  locale?: string
}

/**
 * Fork lineage written by the desktop fork patch into the forked session's metadata
 * (`session.metadata.fork`). It is present already in `session.created` (ids are generated
 * before the session is created), so the plugin can apply it before any copied message
 * event arrives.
 *
 * `boundaryMessageID` is EXCLUSIVE: the first source message that was NOT copied. It is
 * absent when the whole session was copied. `messages` maps source message id -> copied
 * message id. `parts` is no longer written (it bloated metadata and was never read);
 * readers must ignore it.
 */
export type ForkLineageMetadata = {
  sourceSessionID: string
  boundaryMessageID?: string
  messages: Record<string, string>
  /** @deprecated not written; ignore if present */
  parts?: Record<string, string>
}
