# OpenCode Memory acceptance evaluations

This package exercises the shipped core and plugin as a persistent system. The deterministic suite uses real SQLite files, engine reopen cycles, plugin hooks, and the loopback HTTP server. Only the model boundary is faked.

## Commands

From the repository root:

```sh
bun test packages/evals
bun run --cwd packages/evals typecheck
bun run eval:real -- --dry-run
```

The first two commands are hermetic and make no external or paid calls. Tests replace `HOME`, `USERPROFILE`, XDG paths, OpenCode config, and memory data paths with temporary directories before loading the implementation.

## Deterministic acceptance coverage

- Capture: long sessions cross activation/buffer/chunk thresholds, drain to contiguous coverage, re-ingest idempotently, recover after reopen, reclaim expired leases, and use one model flight per project.
- Observer failures: malformed output retries and splits, repetitive child output merges, singleton failures quarantine with a marker, and failed paid runs retain partial token/cost usage.
- Policy and recall: session/project/workspace/user visibility, untrusted agent isolation, instruction refusal, review promotion, cross-session search, exact source recall, and prompt injection.
- Lifecycle: inherited fork coverage, exclusive boundaries, fork-of-fork ancestry, boundaries resolved after source ingestion, and revert/unrevert visibility.
- Erasure: FTS/search, vectors, source parts, snapshots, vault files/outbox, topic generations, backups, WAL, restart, scoped versus global suppression, and no regeneration.
- Prompt lifecycle: stable per-turn blocks across model switches, compaction auto-continue behavior, cache invalidation, and pruning that preserves the latest user message and tool call/result pairs.
- Domains: FSRS due scheduling, assisted versus independent evidence, recalled-attempt exclusion, quiz history, research claims/sources/stances/conflicts, and workspace isolation.
- Artifacts and limits: registration/indexing, path containment, daily token caps, Host/Origin/token/CSP checks, global HTTP forget, recall cursors, and asynchronous command polling.

Passing means every deterministic test passes with no developer configuration, no network access, and no files left outside its temporary roots.

## Real OpenCode evaluation

`real/run.ts` is opt-in. With no confirmation it prints one JSON `skipped` result and performs no network call. `--dry-run` or `--validate` validates configuration and prints a JSON `dry-run` result.

To allow a live/model call, explicitly confirm the cost risk and provide an existing OpenCode server:

```sh
bun run eval:real -- --confirm-live --server=http://127.0.0.1:4096
```

Equivalent environment confirmation:

```text
OPENCODE_MEMORY_EVAL_CONFIRM=I_ACCEPT_LIVE_MODEL_COSTS
OPENCODE_URL=http://127.0.0.1:4096
```

Optional settings:

- `--model=provider/model` or `OPENCODE_MEMORY_EVAL_MODEL`
- `--sessions=N` or `OPENCODE_MEMORY_EVAL_MAX_SESSIONS` (hard maximum 3)
- `--max-cost-usd=N` or `OPENCODE_MEMORY_EVAL_MAX_COST_USD` (default 0.05, hard maximum 1)
- `--timeout-ms=N` or `OPENCODE_MEMORY_EVAL_TIMEOUT_MS` (default 120000, hard maximum 600000)
- `OPENCODE_MEMORY_EVAL_AUTH` for an Authorization header when the local server requires one

The runner creates a temporary project and unique workspace, bounds session count/cost/time, emits only a machine-readable JSON summary on stdout, and deletes each created OpenCode session in a `finally` path. Connection and credential absence produce `skipped`, not a default-CI failure. A live run passes only when every session returns schema-valid observer output containing its unique sentinel and reported cost remains within the configured cap.

The deterministic suite is the CI gate. The real evaluation checks model/provider integration and is never required for normal tests.
