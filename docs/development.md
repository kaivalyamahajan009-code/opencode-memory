# Development and maintenance

## Workspace map

- `packages/core` — runtime-neutral memory engine.
  - `config.ts`, `schemas.ts`, `contract.ts`: configuration, structured domain schemas, shared HTTP/bridge contract.
  - `sqlite.ts`, `schema-sql.ts`: Bun/Node drivers and additive schema convergence.
  - `normalize.ts`, `ingest.ts`, `chunks.ts`: redacted source snapshots and durable chunk/coverage watermarks.
  - `observer.ts`, `reflector.ts`, `prompts.ts`, `runner.ts`, `cost.ts`: structured model pipelines, validation, reflection, retries, and budget accounting.
  - `observations.ts`, `scope.ts`, `retrieval.ts`, `inject.ts`: lifecycle, access policy, search, and prompt blocks.
  - `learning.ts`, `research.ts`, `artifacts.ts`, `embeddings.ts`: domain projections and optional vectors.
  - `forget.ts`, `backup.ts`, `vault.ts`, `lifecycle.ts`, `prune.ts`: deletion/suppression, restore, Markdown projection, forks/reverts, and covered-message pruning.
  - `engine.ts`: orchestration and the public core surface.
- `packages/plugin` — OpenCode hooks, tools, permissions, adapters, runners, service singleton, and loopback HTTP.
- `packages/dashboard` — Solid/Vite `/embed` and `/app` clients.
- `packages/evals/test` — hermetic cross-package acceptance tests.
- `scripts/install-local.mjs` — JSONC-preserving local registration.
- `scripts/rebase-fork.ps1` — guarded rebase of the sibling OpenCode fork's stacked branches.
- `../opencode` — separately versioned thin desktop fork; not a workspace package here.

## Build and test

Install:

```sh
bun install
```

Build the dashboard and plugin:

```sh
bun run build
```

Typecheck:

```sh
bun run typecheck
bun run --cwd packages/dashboard typecheck
```

The root TypeScript project includes core source/tests, plugin source, and evals, but not dashboard source; run both commands.

Hermetic tests:

```sh
bun test packages/core packages/plugin packages/evals
bun test packages/dashboard/test
```

The first command is the root `test` script. It covers unit/integration tests and the acceptance package. Dashboard contract/state tests are a separate invocation.

Node 24 compatibility:

```sh
bun run test:node:core
bun run build
bun run test:node
```

- `test:node:core` bundles the core Node entry and runs it with the current Node executable.
- `test:node` imports the built plugin, exercises hooks/tools/injection/HTTP, and asserts the Node SQLite driver and FTS5. Build first.

Dashboard development:

```sh
bun run --cwd packages/dashboard dev
```

The Vite page still needs a running plugin API for real data/token metadata. The production plugin serves the built dashboard.

### Evaluations

`packages/evals/test` is hermetic acceptance coverage for ingestion/recovery, failures, scope/lifecycle, forget, domain/artifact/cost behavior, and the plugin/HTTP contract.

Validate the real-provider runner without a network/model call:

```sh
bun run eval:real -- --dry-run
```

Live use is explicitly opt-in:

```sh
bun run eval:real -- --confirm-live --server=http://127.0.0.1:4096
```

The runner requires `--confirm-live` (or the documented confirmation environment variable), an existing OpenCode server, and available provider credentials. It creates a temporary project/workspace, deletes created sessions in cleanup, and emits one JSON summary. Defaults are one session, a USD 0.05 cap, and a 120-second timeout; hard limits are three sessions, USD 1, and ten minutes. Connection or credential absence reports `skipped`. See `packages/evals/README.md` for model/auth and bound overrides.

The deterministic suite, not the real-provider eval, is the normal gate. Record the exact provider/model, bounds, status, and summary before using a live result as additional release evidence.

## Desktop fork

The helper expects the fork at the sibling path `../opencode`.

### Develop and build

From the fork root:

```sh
bun install
bun --cwd packages/app typecheck
bun --cwd packages/opencode typecheck
bun --cwd packages/desktop dev
```

Desktop `predev` runs Electron 42.3.3's `install-electron` package binary through `bun run`, copies channel icons, builds the Node sidecar from `packages/opencode`, and prepares the CLI resource before electron-vite starts. The binary is declared by the installed `electron` package; it does not need a same-named package script.

Production asset build and package:

```sh
bun --cwd packages/desktop build
bun --cwd packages/desktop package
```

`prebuild` copies icons/metainfo, builds the sidecar, and downloads the development CLI resource when appropriate. `package:win`, `package:mac`, and `package:linux` are available for explicit targets; platform signing/toolchain requirements are external to this repository.

Focused fork checks:

```sh
bun test --cwd packages/app --conditions=solid --preload ./happydom.ts ./src/components/memory
bun test --cwd packages/desktop ./src/renderer/html.test.ts
bun --cwd packages/app test:unit
```

The first two commands are focused Memory/renderer checks; the third runs all app unit tests. Do not run `bun test` at the OpenCode root: its `bunfig.toml` redirects discovery to a nonexistent guard directory, and the root `test` script also intentionally exits.

### Packaged versus development origins

- Packaged Electron loads `oc://renderer`; this is the memory plugin's default allowed origin.
- Development loads the URL in `ELECTRON_RENDERER_URL`, usually `http://localhost:<electron-vite-port>`.

Add the exact development origin to the memory config:

```json
{
  "allowedOrigins": [
    "oc://renderer",
    "http://localhost:5173"
  ]
}
```

Treat `5173` as an example. Restart the memory plugin after changing origins. The fork accepts only HTTP(S) dashboard URLs whose hostname is exactly `127.0.0.1` or `localhost`; the plugin server itself binds IPv4 `127.0.0.1`. The bridge enforces exact-origin checks and rejects the renderer's own origin as a dashboard target.

### Rebase the stacked fork branches

From the opencode-memory root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\rebase-fork.ps1 -Tag v1.18.32
```

Defaults:

- bottom branch: `feat/inline-svg-and-latex`
- top branch: `memory-tab`
- upstream branch used to locate the old base: `dev`
- maximum replay set: 20 commits

Requirements and behavior:

1. Git 2.38+ and an `upstream` remote.
2. Clean fork worktree and no merge/rebase/cherry-pick in progress.
3. Every named branch exists and is stacked bottom-first.
4. The script fetches only the requested tag and, unless `-OldBase` is supplied, `upstream/dev`; both fetches use `--no-tags`.
5. It refuses an unexpectedly large replay.
6. It creates `refs/backup/<branch>-<timestamp>` for every original tip.
7. For the Windows skip-worktree declaration workaround, it durably saves the exact generated bytes under the fork's Git directory, clears `S`, and materializes only that path's index symlink payload before checking out the top branch or starting replay. Clean failures before Git creates rebase state restore immediately; stopped rebases retain the prepared path and backup. It restores the bytes/`S` bit and removes the durable state only after rebase success.
8. It checks out the top branch and runs one `git rebase --update-refs --onto`, reusing the pre-rebase top commit's committer identity through invocation-scoped `git -c` arguments. It does not write local or global Git identity configuration; Git preserves each replayed commit's original author and message.
9. It runs app/opencode typechecks and the desktop build.
10. It never pushes.

Optional parameters:

```powershell
.\scripts\rebase-fork.ps1 `
  -Tag v1.18.32 `
  -OldBase <commit> `
  -Branches @("feat/inline-svg-and-latex", "memory-tab") `
  -MaxCommits 20
```

The identity/durable-reference path has a hermetic temporary-repository test. It exercises a stacked replay that stops on a real content conflict, continues with the helper, and verifies exact replacement-byte/`S` restoration without touching the sibling fork:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tests\rebase-git.integration.ps1
```

On a conflict, resolve and stage the files, then use the exact `continue-fork-rebase.ps1` command printed by the script. That helper reads the same identity from the original top commit and invokes `git rebase --continue` noninteractively with invocation-scoped configuration; repeat it until the rebase finishes. While conflicts remain, it deliberately leaves the prepared declaration and durable backup untouched. The final successful continuation restores the exact local bytes/`S` bit and removes the backup.

To abandon the replay, run the printed abort/backup-ref recovery commands first, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-fork-rebase-reference.ps1
```

The restore helper refuses to run during an active rebase and never removes the only backup until byte restoration and the `S` bit are verified. See the Windows workaround details in [Troubleshooting](troubleshooting.md#windows-symlink-in-the-desktop-fork).

## Change-safety checklist

Before changing behavior:

- Scope: route agent/injection/read/recall/review/forget decisions through `scope.ts`; test same session, same project, same workspace, other workspace, and user scope.
- Trust: preserve the distinction between `actor: "user"` and `actor: "agent"`; never turn an agent proposal into user attribution.
- Attribution: validate observer refs/quotes against retained source; keep instruction-like non-user text out of future prompts.
- Redaction: redact before persistence or outbound provider requests, and redact before truncating error text.
- Forget: enumerate every derived store—sources, observations/events/reviews, snapshots, learning/research, artifacts, vectors, FTS, reflection/topic generations, journey, vault outbox/files, WAL, and backups. Add replay/restore/fork tests.
- Database: keep transactions synchronous; preserve multi-process leases/versions; test old-schema convergence and restore column intersection.
- HTTP: keep loopback bind, strict Host/Origin, no API CORS, token checks, JSON/object/size checks, confirmation, safe errors, and CSP/no-store. Update `contract.ts` and wire tests together.
- Config: treat dashboard patches as untrusted. Do not expose bind paths/origins/endpoints/secrets through live config writes.
- Filesystem: check lexical and real containment; reject UNC/device paths and symlink/junction escapes; use atomic writes.
- Bridge: check both source and exact origin, post to an exact target, validate IDs/paths, and keep user-presence/focus gates.
- Runtime: exercise Bun SQLite and Node 24 `node:sqlite`; do not introduce Bun-only imports into the Node path.
- Fork: keep copied bridge/contract constants synchronized and retain the loopback-only renderer CSP.
- UI: distinguish 401, unreachable, forbidden, partial forget, restore refusal, and stale cached data; destructive actions require explicit confirmation.

## Release/readiness checklist

1. Pin the desktop integration to exact OpenCode v1.18.32 and verify `@opencode-ai/plugin` / `@opencode-ai/sdk` 1.18.32.
2. Run the root build, both typechecks, core/plugin/eval tests, dashboard tests, and both Node checks.
3. Run focused fork tests, app/opencode typechecks, and desktop build.
4. Install from a clean path using `scripts/install-local.mjs`; verify JSON and JSONC configs plus uninstall/backup behavior.
5. Start two OpenCode windows; verify one dashboard owner, shared status, command routing, and shutdown/rebind.
6. Verify packaged `oc://renderer` and the exact dev localhost origin, including forbidden-origin guidance.
7. Exercise remember/review/edit/supersede/search/recall/source navigation for every scope and both user/agent actors.
8. Exercise learning scheduling and research conflicts with workspace isolation.
9. Exercise artifact path escapes and sanitized SVG/Mermaid rendering.
10. With disposable data, create a backup, forget with/without source purge, wait for WAL/vault/backup scrub, restore, and prove suppression prevents resurrection.
11. Test malformed/oversized HTTP bodies, wrong token/Host/Origin, endpoint errors, auth pause/resume, cost limits, quarantine/retry, FTS fallback, and dashboard-unavailable behavior.
12. Inspect generated vault/backups/exports for secrets and forgotten test markers.
13. Validate the real-eval configuration with `bun run eval:real -- --dry-run`; run it live only when explicitly budgeted and record `passed`, `failed`, or `skipped` honestly.
14. Record exactly which automated/manual checks passed. Make no availability, privacy, erasure, accuracy, or provider-compatibility claim beyond that evidence.

## Known limitations

- Real-provider evals are opt-in, require a separately running OpenCode server/provider credentials, and are not the deterministic test gate. Unavailable connectivity or credentials yields `skipped`.
- Learning concepts/cards and research claims/sources are workspace-wide; project-specific domain views are deferred.
- `observe.activationTokens` gates automatic buffer-driven model work; idle, age, recovery, and explicit flush bypass it. `observe.concurrency` is stored but the current project drain is single-flight.
- Optional embeddings perform a bounded in-process scan of up to 3,000 recent readable rows; there is no vector database/index.
- The dashboard is available only while a plugin process is running and able to own the configured port.
- The desktop Memory tab is fork-only; stock OpenCode can still use tools/commands and `/app`.
- Redaction is pattern-based, storage is unencrypted, and same-user local processes are inside the trust boundary.
- Forget cannot scrub provider logs, exports, external copies, or filesystem snapshots; WAL/vault/backup cleanup can be temporarily pending.
- Recall guarantees retained redacted source, not the original unredacted transcript. Direct writes can have no source.
- Dashboard JSON export is not restorable. Only listed, marked SQLite backups can be restored.
- Direct runner compatibility depends on an OpenAI-style `/chat/completions` endpoint accepting the emitted `response_format.json_schema`.
