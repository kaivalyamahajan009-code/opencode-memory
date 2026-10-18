# Implementation report: how OpenCode Memory was built

This document describes **how the system was implemented**, not how to use it. For operator-facing behavior see [User guide](user-guide.md), [Architecture and security](architecture-security.md), and [Configuration](configuration.md). For contributor commands see [Development](development.md).

The work lives in two repositories:

- `opencode-memory` — the memory engine, OpenCode plugin, dashboard, evals, and install/rebase scripts.
- `../opencode` on branch `memory-tab` — a thin desktop fork that embeds the dashboard. It is stacked on `feat/inline-svg-and-latex` and OpenCode `v1.18.32`.

---

## 1. Design constraints that drove the implementation

The system was built as **local observational memory**, not as a cloud knowledge graph. That produced a set of hard constraints that show up in almost every module:

1. **Same-user local process is inside the trust boundary.** Loopback HTTP, tokens, and CSP stop *other origins*, not other programs running as the same Windows user.
2. **The model is untrusted.** Observer/reflector output is JSON-schema constrained, then validated against retained source, attribution, suppressions, and payloads. Invalid output is dropped, retried, split, or quarantined. It is never treated as ground truth.
3. **Agents and users are different actors.** `actor: "agent"` versus `actor: "user"` is stored on every observation. Placement, review, injection, and forget all branch on it. An agent write is never relabeled as a user write.
4. **Chat must not wait on memory.** Injection has a 250 ms deadline. Miss twice in a row and that session gets a ten-minute cooldown. The turn still proceeds.
5. **Node 24 is the production runtime.** Core cannot import `bun:*` on the Node path. SQLite is abstracted (`bun:sqlite` or `node:sqlite`). Tests run both.
6. **Windows is a first-class host.** Paths, UNC/device rejection, junction/symlink realpath checks, XDG-style `%USERPROFILE%\.config` / `.local\share` (not `%APPDATA%`), and the desktop fork’s skip-worktree `custom-elements.d.ts` rebase workaround were implemented explicitly.
7. **Multi-window OpenCode is normal.** One process owns `127.0.0.1:4777`; others share `memory.db` through WAL, leases, instance heartbeats, and a command queue.

---

## 2. Repository layout and why it was split this way

| Package / path | Responsibility | Why it is separate |
|---|---|---|
| `packages/core` | Policy, SQLite, pipelines, domains | Must run under Bun *and* Node without OpenCode APIs |
| `packages/plugin` | OpenCode hooks, tools, HTTP, runners | The only package that imports `@opencode-ai/plugin` / SDK, pinned to **1.18.32** |
| `packages/dashboard` | Solid/Vite `/app` and `/embed` | Bundled *into* the plugin dist so one process serves UI + API |
| `packages/evals` | Hermetic acceptance + opt-in live eval | Cross-package contracts without a live desktop |
| `scripts/` | Local install and fork rebase | Windows PowerShell + JSONC-preserving Node installer |
| `../opencode` | Memory tab host | Intentionally **not** a workspace package so upstream rebases stay isolated |

The plugin build copies `packages/dashboard/dist` to `packages/plugin/dist/dashboard`. OpenCode loads a `file:///` URL of `packages/plugin/dist/index.js`. There is no published npm package; `scripts/install-local.mjs` registers the checkout.

---

## 3. Core: database and runtime abstraction

### 3.1 Dual SQLite drivers

`packages/core/src/sqlite.ts` wraps both drivers behind one `Database` interface (`exec`, `prepare`, `tx`, `close`, `driver`, `hasFts5`).

On open it always sets:

- `busy_timeout = 8000`
- `journal_mode = WAL` (except `:memory:`)
- `journal_size_limit = 4 MiB`
- `synchronous = NORMAL`
- `foreign_keys = ON`
- `secure_delete = ON`

`tx()` uses `BEGIN IMMEDIATE` and nested `SAVEPOINT`s. The callback **must be synchronous**. Async work inside a transaction would hold a write lock across `await` and break multi-process leases.

FTS5 is probed by creating and dropping a temp virtual table. If the probe fails, `hasFts5` is false and retrieval falls back to in-process BM25 (`retrieval.ts`).

### 3.2 Additive schema convergence

`schema-sql.ts` does not use a linear migration version table as the only strategy. It:

1. Creates the v1 DDL with `CREATE TABLE IF NOT EXISTS`.
2. Adds later columns/indexes with `ALTER TABLE … ADD COLUMN` guarded so old databases keep working.
3. Rebuilds derived structures (FTS, suppression shingles) when needed.

Important table groups (implemented as one schema, not separate databases):

- Identity: `projects`, `sessions`, `fork_map`, `instances`
- Source snapshot: `source_messages`, `source_parts`, `ingest_state`
- Pipeline: `chunks`, `coverage`, `observations`, `observation_sources`, `observation_events`
- Coordination: `jobs`, `commands`, `operations`, `runtime_state`, `meta`
- Review/privacy: `review_items`, `suppressions`, `suppression_shingles`, `context_snapshots`
- Reflection/vault: `reflections`, `topics`, `topic_generations`, `vault_outbox`, `journey_entries`
- Domains: `learning_concepts`, `learning_attempts`, `review_cards`, `research_sources`, `research_claims`, `claim_evidence`, `artifacts`, `embeddings`

`MemoryEngine.open()` opens the DB, migrates, constructs an embedder from config, then runs `recover()` and `retryBackupScrub()`.

### 3.3 Engine as orchestrator

`engine.ts` is deliberately a façade. Domain logic lives in focused modules (`observer.ts`, `chunks.ts`, `forget.ts`, …). The engine:

- registers `InstanceAdapter`s (one per OpenCode working directory in this process);
- owns the drain loops (observe / reflect / vault / backup / command claim);
- exposes the public API used by tools and HTTP;
- generates an `owner` id of `hostname:pid:random` for leases.

An adapter is:

```ts
{
  id, directory, project,
  runner, reflectRunner?,
  fetchMessages(sessionId),
  fetchSession?(sessionId)
}
```

The plugin supplies the OpenCode SDK client behind that interface. Tests supply a fake adapter and `FakeRunner`.

---

## 4. Capture: normalize, redact, ingest

### 4.1 Redaction before anything is stored

`redact.ts` runs **before** source persistence, direct writes, artifact storage, vault sanitization, and user-visible runner errors. Rules are regexes for:

- PEM private keys
- AWS / GitHub / Anthropic / OpenAI / Google / Slack / Stripe tokens
- JWTs
- `Bearer` / `token` prefixes
- URL userinfo
- `secret|token|password|api_key|…` assignments

A second pass redacts high-entropy candidates (`entropy >= 4.2`, mixed character classes, length ≥ 32) unless they look like hex or lowercase words. Replacements are `[REDACTED:rule-name]`. This is heuristic; it is not a secret scanner guarantee.

### 4.2 Message normalization

`normalize.ts` converts OpenCode SDK messages into `OcMessage` / stored parts:

- User messages are complete immediately.
- Assistant messages wait for `time.completed`, or the stale-incomplete timeout (`capture.staleIncompleteMs`, default 30 minutes).
- Reasoning is omitted by default (`capture.captureReasoning: false`) and replaced with an omission marker.
- Memory-tool outputs are omitted so recall cannot recurse into previous memory dumps.
- Tool output is middle-truncated at `snapshotToolOutputMax` (64k).
- Token estimates drive chunking (`estimateTokens`).

### 4.3 Ingest watermarks

`ingest.ts` upserts projects/sessions and appends `source_messages` / `source_parts` with hashes, seq, flags, and status (`present`, `reverted`, `removed`).

`ingest_state.last_seq` is the capture watermark. `ingest_state.chunked_seq` is the chunking watermark. Coverage (`coverage` table) is **separate**: a chunk can exist without having produced observations.

Internal sessions are excluded:

- exact titles `[memory] observer` / `[memory] reflector`
- `engine.markInternal()` after `session.create`
- first message from agents `om-observer` / `om-reflector`

A user’s own title starting with `[memory]` is **not** enough to mark internal.

Forks record `fork_map` / session fork fields so revert and forget can follow copied message/part lineage (`lifecycle.ts`).

---

## 5. Chunking, leases, retries, quarantine

Implemented in `chunks.ts`.

### 5.1 Two-phase observation

1. **Buffer cut** at `observe.bufferTokens` (default 6,000). Durable `chunks` rows are inserted with `reason = 'buffer'` and stay inactive for automatic model work.
2. **Activation** when the session’s unobserved total (pending + retryable + running + unchunked tail) reaches `observe.activationTokens` (default 30,000). `activateBufferChunks()` flips those rows to ready.

Bypass paths that process small sessions anyway:

- idle (`idleFlushMs`, 90s since last activity)
- max age (`maxUnobservedAgeMs`, 10 minutes)
- startup recovery
- explicit flush (`memory_flush` / dashboard Flush)

Chunk IDs are deterministic (`deterministicId("ch", session, start, end, parent, salt)`). Re-cutting the same revert-cancelled range **revives** the row instead of silently no-oping. Forget/exclude cancellations are never revived.

### 5.2 Claiming work

`claimChunk` sets `state = running`, `lease_owner`, `lease_expires_at`, and bumps `version`. If the lease is lost (`StaleLeaseError`), the result is discarded. This is how two OpenCode windows cannot commit the same chunk.

`observe.concurrency` is stored and validated but the engine drains a project through **one single-flight loop**. Increasing concurrency does not currently parallelize observer calls.

### 5.3 Failure classes

`failChunk` classifies via `runner.ts`:

| Class | Behavior |
|---|---|
| `transient` | Retry with exponential backoff; after `maxAttempts * 2` → `quarantined` (`transient_exhausted`) |
| `invalid_output` / others | Retry up to `maxAttempts`; then split if the range has more than one message, else quarantine |
| `oversize` | Split at a message boundary |
| `auth` | Pause workers globally until the user resumes |
| `cost_limit` | Do not run; reservation failed |
| `aborted` | Release without advancing coverage |

Coverage advances **only** on `markSucceeded`. Quarantined chunks are retried from the dashboard (`retryChunk` / `retryAllQuarantined`) which zeros attempts and sets `pending`.

---

## 6. Observer and reflector pipelines

### 6.1 Model runners

`ModelRunner` is `{ id, run(req, signal) }`. Three implementations:

**OpenCodeSessionRunner** (`plugin/src/runners/opencode-session.ts`)

1. `session.create` with `parentID` and title `[memory] observer` or `[memory] reflector`.
2. `engine.markInternal(id)`.
3. `session.prompt` with `agent: om-observer|om-reflector`, optional `{ providerID, modelID }`, and `format: { type: "json_schema", schema, retryCount: 2 }`.
4. Read `info.structured`. Map `StructuredOutputError` / `ProviderAuthError`.
5. `session.delete` in `finally`. Track in-flight IDs so orphan sweep does not delete a live worker.

**DirectRunner** posts to `<baseURL>/chat/completions` with JSON-schema `response_format`. HTTPS except loopback. API key from `apiKeyEnv` only. 401/403 pause workers.

**FakeRunner** for tests: scripted outputs, no network.

The plugin wraps runners in `liveRunner()` so a dashboard config change of `runner.kind` takes effect **without restarting** OpenCode.

### 6.2 Hidden agents

On the plugin `config` hook (`plugin/src/index.ts`):

- Register `om-observer` and `om-reflector` as `mode: "subagent"`, `hidden: true`.
- Pin model from `engine.config.runner.model`, else OpenCode `small_model`.
- Merge user agent config but **force** `hidden`, `mode`, system prompt, and permissions.
- `HIDDEN_AGENT_PERMISSION` denies every tool except `StructuredOutput`. User config may tighten, never widen.
- Primary agents cannot `task` into `om-*` unless the user added an explicit rule (`permission.ts` last-match semantics copied from OpenCode).
- `memory_forget` defaults to `ask` unless the user already configured that permission key.

`slimWorkerSystem()` strips OpenCode’s injected AGENTS.md / MCP / skills block from worker system prompts so the observer only sees the memory system prompt plus the structured-output directive.

**Important implementation detail:** the observer model is **not** the chat model. If `runner.model` is unset, OpenCode’s `small_model` is used. In this installation that resolved to `azure/claude-sonnet-4-6`, which 404’d. Pinning `runner.model` to `{ providerID: "openai", modelID: "gpt-5.6-sol" }` in `~/.config/opencode-memory/config.json` is how observation was unblocked. Switching the session model in the UI does not change the observer.

### 6.3 Observer validation (`observer.ts`)

The model sees a numbered transcript (`m1`, `m2`, …) built by `buildObserverInput` with tool output clipped to `observerToolOutputMax`.

The JSON Schema handed to the model (`OBSERVER_JSON_SCHEMA` in `schemas.ts`) requires `observations` (max 40 items in the schema; Zod also caps the array at 60). Each item must have `kind`, `content` (≤ 1500 chars, third-person, no instructions), `confidence`, `evidenceType`, `priority`, `sources.{start,end}` (`mN` refs), and `scopeHint`. Optional: `quote` (≤ 600), `eventAt`, `payload` (key/value, quiz fields, claim/stance/url/doi, …). `condensed` is not a legal observer kind; the reflector creates those.

Each proposed observation is then parsed with Zod, then:

1. `sources.start` / `sources.end` must exist in **this chunk**.
2. `quote`, if present, must appear verbatim in that range (word-boundary).
3. Kinds in `USER_SOURCED_KINDS` (`preference`, `learning-preference`, `goal`, `personal-fact`) require `attributedToUser()`:
   - strip framing words (“user prefers…”) and light-stem;
   - with a verified quote: ≥ 1/3 of content words in the quote ± 12-token window;
   - without a quote: ≥ 1/2 of content words in **one** user message (never concatenated across messages).
4. Instruction-like text (`INSTRUCTION_PATTERN`) from non-user sources is dropped (prompt-injection guard).
5. Forgotten suppressions (hash + shingles) block recreation.
6. Payload fields not belonging to the kind are dropped; remaining fields are schema-checked.

`currentTask` / `suggestedNext` are stored on session state for the dashboard and injection.

Domain hooks (`applyObservationDomainHooks`) update learning/research/artifact tables only for durable, in-scope rows.

### 6.4 Placement and review (`observations.ts`)

`placeObservation` uses evidence, attribution, actor, and kind:

- Agent writes: active at session/project; `pending_review` at workspace/user; always review for high-impact kinds (`personal-fact`, `conclusion`, `superseded-conclusion`) and mastery claims.
- User/dashboard writes: can enter any scope after redaction/validation.
- Unreviewed agent session rows are readable **only in that session** (`sessionRowReadable`).

`memoryGeneration` in `meta` is bumped in the same transaction as forget/edit/supersede/review/revert/pin/topics/config/pause/flags/promotion/restore, and when learning/research domain hooks write workspace-visible state. **New observations of ordinary kinds do not bump it** (`created` / `reobserved` are additive events) so a prompt block can stay stable for the rest of a turn. Other processes invalidate injected blocks by comparing this counter plus `observation_events` watermark.

### 6.5 Reflector

`reflector.ts` claims a job `reflect:<scopeKey>`, loads durable observations since last reflection, and asks the reflector for an `ops` array (create/merge topics, condense, supersede, journey, propose promotion). Ops that do not cite live input observations are dropped. Mastery assertions from the reflector are refused. Topic Markdown is enqueued on `vault_outbox` and materialized asynchronously with lexical + realpath containment checks.

---

## 7. Scope policy (single chokepoint)

Every read, injection, search, recall, review narrowing, promotion, and scoped forget goes through `scope.ts`.

- Workspace is the **sharing boundary**.
- Domain (`general` | `learning` | `research`) is classification only.
- `readFilterSql()` is the SQL equivalent of `canRead()` so tools, injection, and HTTP cannot drift.
- Source recall is stricter than observation visibility: user-scoped facts from another workspace show content, not source.

SQL and JS implementations are tested together (same session / project / workspace / other workspace / user).

---

## 8. Retrieval and prompt injection

### 8.1 Search

`retrieval.ts`: FTS5 BM25 when available; otherwise JS BM25. Optional OpenAI-compatible embeddings (`embeddings.ts`) blend vector rank with text rank. Query embedding is bounded by **half** of `inject.deadlineMs`. Vector scan is capped at 3,000 recent readable rows — there is no vector index.

### 8.2 Injection block

`inject.ts` builds a deterministic `<opencode-memory hash="…">` block:

- Sections: profile (user), workspace topics/journey, project, session, task, recall hits for the last user text.
- Token budgets from `inject.budget`.
- Ranking uses **start of UTC day** plus id tie-break so identical DB state produces a byte-identical block (provider prompt-cache friendly).
- Pending-review rows inject only if `actor === "user"` and not instruction-like.
- Internal title/summary/compaction/observer/reflector prompts are detected by prefix and never receive a block (`isInternalSystem`).

Plugin hook `experimental.chat.system.transform`:

1. Skip internal sessions; slim worker system instead.
2. Reuse `injectionMemo` for the same user `messageID` if `memoFresh()` (generation + event watermark + still-visible IDs).
3. Otherwise `withTimeout(engine.buildInjection(…), deadlineMs)`.
4. Two consecutive timeouts → cooldown `DEADLINE_COOLDOWN_MS` (10 minutes).
5. Record the block actually sent (`recordContextSnapshot`) so the dashboard can show “what was injected.”

Compaction: `compactionNote()` attaches a short INDEX/JOURNEY/session summary (800-token budget). Optional `pruning.ts` removes already-covered older messages from the **request**, not from retained source (off by default).

---

## 9. Plugin service, hooks, and tools

### 9.1 Process-global singleton

`service.ts` stores the engine on `globalThis` under `Symbol.for("opencode-memory.service")` with a refcount. Multiple plugin instances in one Node process share one engine and one HTTP server. `acquireService` registers an adapter; `release` unregisters and closes HTTP/DB when refs hit zero.

Token: 32 random bytes hex at `<dataDir>/token`, created once.

### 9.2 Lifecycle hooks

| Hook | Implementation |
|---|---|
| `config` | Hidden agents, commands, permissions |
| `event` | `session.created/updated/deleted/idle`, `message.updated`, `message.part.updated` → track, revert/unrevert, ingest debounce 1500 ms, inline SVG/Mermaid capture |
| `chat.message` | Record last user text (for quiz attribution) and current message id |
| `experimental.chat.system.transform` | Injection |
| `experimental.chat.messages.transform` | Optional prune of covered messages |
| tools | `createTools()` |
| HTTP | started in `bootService` |

`chat.params` re-keys a pending injection memo when OpenCode assigns the real user message id.

Orphan sweep: list sessions titled exactly `[memory] observer|reflector` older than 10 minutes that this process created or that started with an `om-*` agent; delete them. User sessions with a `[memory]` prefix are left alone.

### 9.3 Tool implementations (`tools.ts`)

Tools call `engine.*` with `AccessContext` from the current session. Notable implementation choices:

- `memory_forget` with only `query` lists candidates; with `ids` it `context.ask({ permission: "memory_forget" })` then forgets with `purgeSources: "none"` and `scope: "ctx"`.
- `learning_record_attempt` requires the answer to appear in the latest user message (`quotedInText`, ≥ 3 words). Recalled evidence cannot mint an attempt. Hints force `independent: false`. Writes go through `engine.remember({ actor: "agent" })` so they stay session-scoped or enter review — they do **not** update workspace FSRS/mastery tables until approval.
- `artifact_register` resolves the path against the project directory, rejects UNC/device paths, requires `.svg|.mmd|.mermaid`, `realpath` both sides, and `inside()` after case-folding on Windows. Max 2 MB; render payload capped at 200k characters.
- Write/edit/patch tools also auto-index artifacts via `captureToolArtifacts`.

Slash commands are **templates** (`MEMORY_COMMANDS`), not extra code paths. They tell the primary agent which tool to call.

---

## 10. Loopback HTTP and dashboard

### 10.1 Server (`plugin/src/server/http.ts`)

- `listen({ host: "127.0.0.1", port })` only.
- If bind fails, probe `/health`; if it is already this service, share; else retry every 30s.
- `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard).
- `Origin`, when present, must be the server origin or an exact `allowedOrigins` entry (`oc://renderer` by default).
- No-Origin plus `Sec-Fetch-Site: cross-site` is rejected except GET navigation to `/app`, `/app/*`, `/embed`.
- CORS preflight is rejected. `/api` never sends permissive CORS.
- `/api/*` requires `X-OM-Token` compared with `timingSafeEqual` (length mismatch still runs a dummy compare).
- POST must be `application/json` object, ≤ 1 MB; oversized bodies close the connection.
- Destructive forget/restore require `confirm: true`.
- HTML gets `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and CSP (`default-src 'self'`, `frame-ancestors` = self + allowedOrigins). Token and served config are escaped into meta tags (`om-token`, `om-config`).
- Config GET masks header values as `***`. Config POST strips bind paths, secrets, and unknown keys through `parseConfigPatch` / `stripSensitiveConfigPatch`.
- Dashboard actions that need an OpenCode adapter (`flush`, `reflect`, …) use `engine.routeCommand`: run locally if this process owns the directory, otherwise insert a `commands` row for the owner to claim.

`contract.ts` is the shared HTTP/bridge type surface. Dashboard wire tests and plugin HTTP tests assert it together.

### 10.2 Dashboard (`packages/dashboard`)

Solid + Vite. Two entries:

- `/embed` — session-scoped Memory tab UI (`embed.tsx`).
- `/app` — full SPA with Overview, Timeline, Search, Knowledge, Learning, Research, Artifacts, Review, Runs, Settings.

Polling uses generation-guarded config loads so a slow GET cannot overwrite a just-saved config. Destructive UI requires confirmation. SVG is sanitized (`svg-xml.ts`) before render. Settings can change thresholds and `runner.model` live; they cannot change `dataDir`, `port`, `allowedOrigins`, or endpoint secrets.

### 10.3 Embed bridge

Dashboard `bridge.ts` / `bridge-parse.ts`:

- Discover host origin from `ancestorOrigins` or `?hostOrigin=`, **only if** it is in `allowedOrigins`.
- `postMessage` to that exact origin.
- Incoming events require `event.source === window.parent` and exact `event.origin`.

Host (fork) `packages/app/src/components/memory/bridge.ts`:

- Dashboard URL hostname must be exactly `127.0.0.1` or `localhost`.
- Probe `/health` before embedding.
- Sandboxed iframe of `/embed`.
- Honor `om:navigate`, `om:insert`, `om:status`, `om:open-dashboard` only while the Memory tab is active **and** the iframe has focus.
- Insert appends ≤ 16,000 characters, does not replace, does not submit, forces normal composer mode.
- Navigation validates session/message IDs, maps assistant messages to parent user messages, loads a bounded history window.

Electron CSP in the fork allows HTTP(S) frames only to those loopback hostnames. Packaged origin is `oc://renderer`.

---

## 11. Learning, research, artifacts

### 11.1 Learning (`learning.ts`)

Workspace-keyed concepts (not project-keyed — a known limitation).

- Attempts update a concept card after they become durable/approved.
- FSRS (`review_cards`) schedules recall practice separately from mastery.
- Mastery is evidence-based: `introduced` → `practicing` → `demonstrated` (one independent correct) → `retained` (two independent correct on distinct days ≥ 3 days apart, no open misconception) → `needs-retention-check` if stale > 45 days.
- Forgetting an attempt rebuilds the card from remaining attempts.

### 11.2 Research (`research.ts`)

Claims, sources (URL/DOI identity), and `claim_evidence` with stance `support|contradict`. Status is **derived**: open / supported / refuted / contested / superseded. Agent-recorded claims stay session-scoped until review. This is an evidence organizer, not a verifier.

### 11.3 Artifacts (`artifacts.ts`)

Indexed from tool writes, inline fenced/raw SVG/Mermaid in completed assistant text, or `artifact_register`. Stored content is sanitized for dashboard display. Paths cannot escape the project after `realpath`.

---

## 12. Forget, vault, backup

### 12.1 Forget (`forget.ts`)

Observation text is replaced with `[forgotten]`; plaintext is not left in lifecycle rows. Suppressions store **hashes and shingles**, not forgotten text.

Expansion:

- predecessors forgotten; successors not implied
- forgetting a source removes condensed summaries built from it
- forgetting a condensed summary can reactivate its sources
- fork copies followed through recorded lineage
- agent forget never crosses stored project/workspace
- dashboard user forget is global after confirmation

Derived stores scrubbed: learning/research, artifacts, embeddings, review items, context snapshots, topic generations, journey, FTS, vault outbox. `bumpMemoryGeneration` invalidates injection.

Session forget permanently excludes the session and copies.

Pending markers: WAL truncate checkpoint and backup scrub. The HTTP request usually returns while backup scrub still runs. Restore **re-applies** suppressions, so forgotten content cannot be resurrected from a listed backup.

### 12.2 Vault (`vault.ts`)

Async projection. Atomic writes. Conflict if the on-disk hash ≠ stored generation hash. Forget can force rewrite/delete. UNC/device/symlink escapes refused.

### 12.3 Backup (`backup.ts`)

`VACUUM INTO` marked snapshots in `<dataDir>/backups`. Restore intersects columns with the live schema, keeps live operational tables/connections, merges suppressions, rebuilds FTS. JSON export is **not** a restorable backup and is not scrubbed after later forget.

---

## 13. Cost accounting

Every observer/reflector call `reserveRun`s against `cost.dailyCapUsd` and `dailyTokenCap` (local-day buckets in `operations`). Direct runner uses configured $/MTok; OpenCode-session uses child-session usage. Caps of `0` are not unlimited — they prevent runs. Auth strikes pause workers.

---

## 14. Configuration loading

`config.ts`:

- Strict Zod patches; reject `__proto__` / `constructor` / `prototype`.
- Deep-merge valid sections over defaults; invalid **section** falls back as a whole.
- `saveConfigPatch` writes atomically (temp + rename) and refuses to touch a file that is not an object.
- Header maps validated as HTTP field names; CR/LF rejected; generated `Content-Type` / `Authorization` cannot be overridden by custom headers.

Project file `.opencode/memory.json`: `{ workspace, domain, name, exclude }`. Global OpenCode sessions (`project.id === "global"`) are remapped to `dir:<sha256(directory)[0:16]>` so two folders do not collide.

Installer (`scripts/install-local.mjs`): finds OpenCode config (JSONC preserved, comments kept), backs up to `.bak-<ISO>`, inserts `file:///C:/…/packages/plugin/dist/index.js`. Uninstall removes only that exact URL.

---

## 15. Desktop fork and Windows rebase

The fork adds:

- `packages/app/src/components/memory/*` (tab, embed, bridge tests)
- side-panel registration, settings toggle, i18n strings
- Electron CSP `frame-src` for loopback
- session fork lineage plumbing in `packages/opencode`

It is stacked: `v1.18.32` → `feat/inline-svg-and-latex` → `memory-tab`.

`scripts/rebase-fork.ps1`:

- Git 2.38+ `--update-refs` stacked rebase onto an upstream tag
- refuses dirty trees and oversized replay
- writes `refs/backup/<branch>-<timestamp>` (never pushes)
- reuses the top commit’s committer via `git -c user.name=… -c user.email=…` without writing git config
- **Windows skip-worktree:** `custom-elements.d.ts` is a local generated replacement. The script copies exact bytes into `.git/opencode-memory-rebase-reference`, clears the `S` bit, materializes the index blob for replay, then restores bytes + `S` on success. `continue-fork-rebase.ps1` / `restore-fork-rebase-reference.ps1` handle conflicts/abort. Integration test uses a temp repo, not the real fork.

Packaging as production OpenCode used `OPENCODE_CHANNEL=prod` so the installer is named **OpenCode** (not OpenCode Dev) while still containing SVG/LaTeX + Memory. Official in-app updates must not be applied over that build.

---

## 16. Testing strategy

| Layer | What it proves |
|---|---|
| `packages/core/test` | chunks, activation, observer validation, scope, forget expansion, inject determinism, leases, cost, restore, redaction |
| `packages/plugin/test` | hooks, HTTP Host/Origin/token/CSP, tools, install-local JSONC, adapters, runners |
| `packages/dashboard/test` | contract, bridge parse, settings patches, status derivation, SVG sanitize |
| `packages/evals/test` | hermetic acceptance: ingestion/recovery, failures, scope/lifecycle, forget, domains/artifacts/cost, plugin contract |
| `test:node` / `test:node:core` | built plugin on Node 24 `node:sqlite` + FTS5 |
| Fork unit tests | Memory tab bridge, renderer HTML CSP |
| `scripts/tests/rebase-git.integration.ps1` | stacked rebase identity + skip-worktree restore |

Live `eval:real` is opt-in (`--confirm-live`), cost-capped, and not the merge gate.

---

## 17. End-to-end path (what actually runs on a turn)

1. User sends a message in OpenCode.
2. Plugin records last-user text and message id; `system.transform` builds or reuses an injection block under 250 ms and pushes it into the system prompt.
3. On `message.updated` / idle, ingest copies completed redacted parts into SQLite.
4. When buffer/activation/idle/flush fires, `observeNext` claims a chunk, reserves cost, runs `om-observer` (or direct), validates JSON, inserts observations, updates coverage, domain hooks.
5. Dashboard/tools read through `scope.ts`. Review queue holds shared/high-impact agent proposals.
6. When durable volume crosses reflect thresholds, `om-reflector` writes topic generations; vault outbox materializes Markdown.
7. Forget replaces text with markers, writes suppressions, schedules WAL/backup scrub.
8. Next turn’s injection sees the new generation if forget/edit happened; otherwise the memoized block is reused for every step of the same user message.

---

## 18. HTTP surface (implemented routes)

Public pages (no API token; CSP and Host/Origin still apply):

| Method | Path | Role |
|---|---|---|
| GET | `/health` | Probe for bind sharing and the fork tab |
| GET | `/` | Redirect to `/app` |
| GET | `/app`, `/app/*` | Full dashboard SPA |
| GET | `/embed` | Memory-tab iframe |
| GET | `/assets/*` | Vite-hashed dashboard assets |

Authenticated `/api/*` (`X-OM-Token`, JSON POSTs ≤ 1 MB):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | Session + global observing/paused/quarantine |
| GET | `/api/projects`, `/workspaces`, `/sessions` | Directory listings |
| GET | `/api/observations`, `/api/observations/:id` | Scoped reads |
| GET | `/api/search`, `/recall`, `/timeline`, `/context` | Retrieval and last injected snapshot |
| GET | `/api/review` | Open/resolved queue |
| POST | `/api/review/:id` | `decision: approve\|reject`, optional content edit |
| POST | `/api/observations/:id/pin\|edit\|supersede` | User dashboard writes |
| POST | `/api/remember` | Direct write as `actor: "user"` |
| POST | `/api/forget/candidates`, `/forget`, `/forget/session` | Forget requires `confirm: true` |
| POST | `/api/flush`, `/reflect`, `/pause` | Routed commands if another process owns the directory |
| POST | `/api/sessions/:id/flags` | Per-session pause/exclude |
| POST | `/api/chunks/retry-quarantined`, `/api/chunks/:id/retry` | Requeue observer work |
| GET | `/api/operations`, `/jobs`, `/commands/:id` | Runs / command queue |
| GET/POST | `/api/topics…` | List, approve, rollback generations |
| GET | `/api/learning`, `/research`, `/artifacts`, `/artifacts/:id` | Domain views |
| GET/POST | `/api/backups`, `/backups/restore` | Restore requires `confirm: true` |
| GET | `/api/export` | JSON dump (not restorable, not forget-scrubbed) |
| GET/POST | `/api/config` | Masked GET; stripped POST patch |
| POST | `/api/redact-test` | Preview redaction without storing |

There is no CORS for `/api`. Preflight `OPTIONS` is rejected.

## 19. Tools, slash commands, and defaults

Agent tools in `packages/plugin/src/tools.ts` (all go through `scope.ts` / engine):

| Tool | What it does |
|---|---|
| `memory_status` | Session + global observing/buffer/error text |
| `memory_observations` | List readable rows for this session |
| `memory_search` | FTS/BM25 (+ optional vectors) |
| `memory_recall_source` | Retained redacted source for an id |
| `memory_remember` | Agent write (`actor: "agent"`) |
| `memory_supersede` | Replace a row with a new one |
| `memory_forget` | Candidates without `ids`; with `ids` asks `memory_forget` permission |
| `memory_flush` | Cut + activate + observe now (bypasses 30k gate) |
| `learning_due` / `learning_due_reviews` | FSRS-due cards |
| `learning_record_attempt` | Quiz attempt only if the answer is in the latest user message |
| `research_claims` | Claims list |
| `research_conflicts` | Contested claims |
| `research_claim` | Record a claim |
| `research_evidence` | Attach support/contradict evidence |
| `artifact_register` | Index an in-project `.svg` / `.mmd` / `.mermaid` |

Slash commands (`MEMORY_COMMANDS`) are prompt templates only: `/remember`, `/recall`, `/memory-status`, `/review-due`, `/claims`.

Default thresholds from `defaultConfig()` (overridable in `~/.config/opencode-memory/config.json`):

| Key | Default |
|---|---|
| `observe.bufferTokens` | 6,000 |
| `observe.activationTokens` | 30,000 |
| `observe.maxChunkTokens` | 12,000 |
| `observe.minFlushTokens` | 150 |
| `observe.idleFlushMs` | 90s |
| `observe.maxUnobservedAgeMs` | 10 min |
| `observe.observerToolOutputMax` | 4,000 |
| `observe.maxAttempts` | 3 |
| `observe.leaseMs` | 5 min |
| `observe.concurrency` | 1 (stored; drain is still single-flight) |
| `reflect.thresholdTokens` / `minNewDurable` | 40,000 / 25 |
| `inject.deadlineMs` | 250 |
| `inject.budget` | profile 600, workspace 900, project 900, session 2400, task 300, recall 900 |
| `cost.dailyCapUsd` / `dailyTokenCap` | 1 / 2,000,000 |
| `port` | 4777 |
| `allowedOrigins` | `["oc://renderer"]` |
| `pruning.enabled` | false |

## 20. Files to read first when changing behavior

- Scope/trust: `packages/core/src/scope.ts`, `observations.ts`, `observer.ts` (`attributedToUser`, `validateObserverOutput`)
- Capture: `normalize.ts`, `ingest.ts`, `redact.ts`, `chunks.ts`
- Chat integration: `packages/plugin/src/index.ts`, `inject.ts`, `service.ts`
- HTTP: `packages/plugin/src/server/http.ts`, `packages/core/src/contract.ts`
- Privacy: `forget.ts`, `backup.ts`
- Desktop: `../opencode/packages/app/src/components/memory/`
- Change-safety checklist: [Development](development.md#change-safety-checklist)
