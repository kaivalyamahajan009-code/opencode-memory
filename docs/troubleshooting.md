# Troubleshooting

## Plugin does not load

1. Build the local entrypoint:

   ```sh
   bun run build
   ```

2. Confirm `packages/plugin/dist/index.js` and `packages/plugin/dist/dashboard/index.html` exist.
3. Re-run `node scripts/install-local.mjs` and inspect the config path it prints.
4. Confirm that config's `plugin` array contains the absolute `file:` URL for this checkout.
5. Restart every OpenCode process.

The installer warns, but does not fail, when the plugin build is absent. If the checkout moved, remove the old file URL manually or run uninstall from the old checkout; the new checkout's uninstaller only recognizes its own URL.

OpenCode config selection and OS paths are in [Getting started](getting-started.md#opencode-config-selected-by-the-installer).

## Dashboard or Memory tab unavailable

Probe:

```sh
curl http://127.0.0.1:4777/health
```

Expected payload includes `"ok":true`, `"name":"opencode-memory"`, and `"api":1`.

- No response: no plugin process is serving that configured port. Check plugin load/build and OpenCode logs.
- Wrong payload: another process owns the port. Change `port` in the memory config or stop that process, then restart OpenCode.
- `/app` says “dashboard is not built yet”: rebuild so the plugin contains dashboard assets.
- Memory is capturing but the tab is unavailable: the HTTP bind can fail independently of the core. Resolve the port/origin issue.
- “No OpenCode window owns this project”: Flush/Reflect was requested from a dashboard whose project has no live plugin instance (heartbeat must be newer than 120 seconds). Open that project in OpenCode and retry.

The server binds IPv4 `127.0.0.1` only. The fork accepts dashboard URLs only over HTTP(S) with the exact hostname `127.0.0.1` or `localhost`, and its bridge enforces exact-origin checks. Use one of the documented URLs rather than an IPv6 literal or host alias.

## 401 Unauthorized

`/api/*` requires the token embedded into a freshly served `/app` or `/embed` page.

- Reload the dashboard from its loopback URL; do not reuse copied HTML.
- Confirm the dashboard port points to the same data directory/service.
- If rotating a token, close all OpenCode processes, remove `<dataDir>/token`, and restart. A new token is created. Removing it while the service is running does not change the token already in memory.
- Do not paste the token into bug reports.

A plain request to `/api/status` without `X-OM-Token` returning 401 is expected.

## 403 forbidden host

The request `Host` must be exactly `127.0.0.1:<configured-port>` or `localhost:<configured-port>`.

- Use `http://127.0.0.1:4777` or `http://localhost:4777`.
- Do not use a machine name, custom hosts-file alias, reverse proxy, port-forward, or container hostname.
- Ensure the URL port and configured `port` are identical.

This check is intentional DNS-rebinding protection.

## Forbidden origin / Memory tab says origin not allowed

Add the host renderer's exact origin to `allowedOrigins` in `~/.config/opencode-memory/config.json`, then restart all OpenCode windows.

Packaged desktop:

```json
{
  "allowedOrigins": ["oc://renderer"]
}
```

Desktop development example:

```json
{
  "allowedOrigins": [
    "oc://renderer",
    "http://localhost:5173"
  ]
}
```

Use the actual `ELECTRON_RENDERER_URL` / `window.location.origin`; electron-vite may use another port. Origins are exact strings—no wildcards, paths, or trailing slash. The dashboard Settings page intentionally cannot change this field.

If `/health` is reachable from a terminal but the tab reports forbidden, this is usually the origin check: the plugin's rejected response has no CORS header and browsers surface it as a failed fetch.

## Port takeover or multiple data directories

When a bind gets `EADDRINUSE`, the plugin probes `/health`:

- if the response identifies opencode-memory, it assumes another instance is the dashboard server;
- otherwise it retries every 30 seconds.

Do not run independent memory data directories on the same port. The second instance can mistake the first service for its own UI even though their databases differ. Assign a distinct port to each independent data root.

## Workers pause for authentication

The status reason `auth` means observer/reflector credentials were rejected or required direct configuration is missing.

- `opencode-session`: fix the provider/model credentials in OpenCode. Confirm configured provider/model IDs exist.
- `direct`: ensure the OpenCode process inherited the environment variable named by `apiKeyEnv`; verify `baseURL`, `model`, and HTTPS/loopback rules.
- A separate `reflectorRunner` using `direct` needs its own complete `direct` block.

After fixing credentials, choose **Resume** in the Memory tab/dashboard. Resume clears the auth strike/backoff and makes auth-failed pending chunks eligible again. Inspect **Runs** for the latest bounded/redacted error.

Configured custom `headers` are sent by direct and embedding requests. Generated JSON content type and API-key Bearer authorization take precedence; invalid names, prototype-reaching keys, and CR/LF values are rejected. See [Configuration](configuration.md#direct-runner-example) for the full precedence rules.

## SQLite, locking, or FTS

- Close all OpenCode windows before manually copying/removing database files.
- Keep `memory.db`, `memory.db-wal`, and `memory.db-shm` together. Never delete WAL/SHM while a process is live.
- SQLite waits up to eight seconds for a busy writer. Persistent lock errors usually mean another process or filesystem tool holds the file.
- Keep the database on a local filesystem; network/UNC storage is not a supported safety boundary.
- Check `/memory-status` or Overview for `driver` and `FTS5`.

Without FTS5, search uses a bounded JavaScript BM25 fallback. The Node smoke test expects Node 24's `node:sqlite` build to provide FTS5:

```sh
bun run test:node:core
bun run build
bun run test:node
```

If schema convergence fails, preserve the data directory, capture the exact error, and test restore from a listed backup. Do not replace `memory.db` with an arbitrary SQLite file.

## Windows symlink in the desktop fork

The fork tracks `packages/app/src/custom-elements.d.ts` as a mode-120000 symlink. A Windows checkout without symlink support may materialize it as a one-line file containing only the target path, causing typecheck errors.

Preferred fix: enable Windows Developer Mode (or run with symlink privilege), set `git config core.symlinks true`, and re-check out the path.

Local non-symlink workaround from the fork root:

```powershell
[IO.File]::WriteAllText(
  "$PWD\packages\app\src\custom-elements.d.ts",
  '/// <reference path="../../ui/src/custom-elements.d.ts" />'
)
git update-index --skip-worktree -- packages/app/src/custom-elements.d.ts
```

Do not commit the workaround; the index must remain a symlink. `scripts/rebase-fork.ps1` detects a skipped mode-120000 regular replacement and, before replay, atomically publishes its exact bytes under the fork's Git directory. It then clears `S` and writes that path's exact index symlink payload into the worktree so Git can update it safely. A stopped rebase leaves this prepared representation and durable backup in place; the printed `continue-fork-rebase.ps1` command restores the original bytes/`S` bit only after the rebase finishes.

If abandoning a stopped rebase, run `git rebase --abort` and any printed branch recovery commands first, then restore the workaround:

```powershell
powershell -ExecutionPolicy Bypass -File ..\opencode-memory\scripts\restore-fork-rebase-reference.ps1
```

The helper refuses to restore during an active rebase and retains the Git-dir backup until both the exact bytes and `S` bit verify. To return to normal tracking when no durable rebase backup exists:

```powershell
git update-index --no-skip-worktree -- packages/app/src/custom-elements.d.ts
```

Then restore/re-check out the symlink only after symlink support is working.

## Restore is refused

The dashboard restores only a filename currently listed in `<dataDir>/backups`. It refuses:

- unknown, missing, or empty files;
- non-SQLite/non-opencode-memory files;
- unsupported/newer schema versions;
- files without the backup marker;
- backups containing no sessions, observations, or topics.

A refusal leaves the live database untouched. Choose a listed backup created by this service. Restore is not an import mechanism for JSON exports or arbitrary databases.

Forgotten content is not restored: live and backup suppressions are merged and reapplied.

## Forgotten session cannot be included

This is intentional. Session forget creates a permanent session suppression, excludes the session, purges its retained source/fork copies, and refuses future writes. “Include session” is unavailable and the API returns a conflict.

There is no supported unforget. A backup restore also preserves suppressions. Start a new OpenCode session if work should continue under observation.

## Forget says backups are still being cleaned

Forget returns before its default background scrub finishes. The pending marker survives restart and maintenance retries with exponential backoff.

- Keep at least one OpenCode instance running to process retries.
- Inspect logs/Overview/Runs for filesystem errors.
- Ensure backup and vault files are writable and not locked by sync/antivirus software.
- Do not assume the old bytes are gone until cleanup succeeds.

Exports and external copies are never scrubbed.

## Observation never appears

Check, in order:

- session is not paused, excluded, deleted, forgotten, internal, or an excluded subagent;
- project `.opencode/memory.json` does not set `exclude: true`;
- automatic buffered work reached `observe.activationTokens`, the session became idle/stale, or use **Flush now**;
- a tiny idle tail below `minFlushTokens` waits for max age, recovery, more text, or an explicit flush;
- memory is not globally paused or over daily cost/token caps;
- worker credentials work;
- **Runs** has no quarantined chunk; retry it after fixing the cause;
- model output passed source/attribution/schema validation.

`bufferTokens` controls durable chunk boundaries; it does not by itself start the model. Automatic buffer-driven observation starts when total unobserved session work reaches `activationTokens`. Age, idle, startup recovery, and explicit flush bypass that gate so small sessions are eventually processed.

## Source recall is missing or denied

- Directly written observations may have no source.
- A readable user-scope memory can have a source hidden across workspaces.
- Workspace source recall requires the same workspace.
- Session/project source recall requires the same project.
- Purged source parts show `[forgotten]`.
- Long recall is paged; use **Load more** or the returned cursor.

These restrictions are scope policy, not a search failure.
