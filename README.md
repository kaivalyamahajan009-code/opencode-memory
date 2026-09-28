# OpenCode Memory

Local observational memory for OpenCode sessions. The plugin retains a redacted source snapshot, asks an observer model to extract attributable observations, retrieves relevant memory into later turns, and gives the user a reviewable dashboard. Learning and research are the first domain-specific workflows; this is not a remote knowledge service or a guarantee that model-generated observations are true.

## What is implemented

- Session capture with configurable reasoning/tool-output limits and secret redaction.
- Observations at session, project, workspace, and user scopes, with source ranges and exact recall of the retained, redacted snapshot.
- Automatic prompt injection, optional message pruning, background observation/reflection, cost caps, retries, and pause controls.
- Human review for agent proposals that would become shared or high-impact memory.
- Learning concepts, quiz/retention attempts, and FSRS review scheduling.
- Research claims, sources, supporting/contradicting evidence, and conflict reports.
- SVG/Mermaid artifact indexing and sanitized dashboard rendering.
- SQLite storage, generated Markdown vault notes, JSON export, and scrub-aware SQLite backups.
- A full browser dashboard at `http://127.0.0.1:4777/app` and an `/embed` view used by the optional desktop fork's Memory tab.

Current boundaries: learning and research state is workspace-wide rather than project-specific; embeddings are optional and off by default; the dashboard exists only while a plugin process owns the loopback port; the desktop fork is a thin, separately built integration. See [known limitations](docs/development.md#known-limitations).

## Architecture

The OpenCode plugin captures lifecycle events and exposes memory tools. The Node-compatible core owns policy, SQLite, retrieval, review, learning/research, the vault, and backups. One plugin process binds `127.0.0.1`; other OpenCode windows share the database and route long-running commands through it. The dashboard is bundled into the plugin. The desktop fork only embeds `/embed`, passes session context over a constrained `postMessage` bridge, and opens `/app` for the complete UI.

See [Architecture, data, and security](docs/architecture-security.md) for the component flow, scope rules, trust boundaries, and forget semantics.

## Requirements

- [Bun](https://bun.sh/) for dependency installation, builds, typechecks, and tests.
- Node.js 24 for the local installer and the supported `node:sqlite` runtime/checks.
- OpenCode v1.18.32 for desktop-fork integration; the plugin pins `@opencode-ai/plugin` and `@opencode-ai/sdk` exactly to 1.18.32.

The core also detects Bun and uses `bun:sqlite`; otherwise it uses `node:sqlite`.

## Install locally

From this repository:

```sh
bun install
bun run build
node scripts/install-local.mjs
```

The build creates the dashboard and `packages/plugin/dist/index.js`. The installer adds that absolute file URL to OpenCode's `plugin` array, preserves JSONC comments, and backs up an existing config before changing it. Restart OpenCode, open a normal session, and run `/memory-status` or open `http://127.0.0.1:4777/app`.

To update after pulling changes:

```sh
bun install
bun run build
```

Restart OpenCode. Re-run the installer only if the checkout moved or its OpenCode plugin entry was removed.

To unregister the current checkout:

```sh
node scripts/install-local.mjs --uninstall
```

Uninstall does not remove memory data, the memory config, vault, or backups. See [Installation and paths](docs/getting-started.md) for OS-specific locations, environment overrides, updates, and complete removal.

## Configure a project

Optional `.opencode/memory.json`:

```json
{
  "workspace": "personal-knowledge",
  "domain": "learning",
  "name": "Algorithms course",
  "exclude": false
}
```

`domain` is `general`, `learning`, or `research`. The workspace is the cross-project sharing boundary; domain is a classification and controls the focused dashboard cards. Global configuration is JSON at `~/.config/opencode-memory/config.json` by default.

Start from the safe examples in [Configuration](docs/configuration.md). In particular:

- `runner.kind: "opencode-session"` uses hidden OpenCode child sessions and the configured model, OpenCode `small_model`, or the current session model.
- `runner.kind: "direct"` calls an OpenAI-compatible `/chat/completions` endpoint; keep API keys in an environment variable named by `apiKeyEnv`.
- Embeddings call an OpenAI-compatible `/embeddings` endpoint and send redacted observation text to it. They are disabled by default.
- Add the desktop renderer's exact origin to `allowedOrigins`: `oc://renderer` when packaged, or the exact `http://localhost:<port>` origin used in desktop development.

Never put an API key value in the JSON file or in documentation.

## Use it

OpenCode commands added by the plugin:

- `/remember …` — ask the agent to call `memory_remember`.
- `/recall …` — search observations, then recall retained source.
- `/memory-status` — show capture, observer, SQLite/FTS, and review status.
- `/review-due` — list learning concepts due for review.
- `/claims …` — list research claims and conflicts.

The Memory tab in the desktop fork shows this session's status, injected context, review queue, learning/research cards, timeline, search/recall, and Remember/Flush/Pause actions. Source links navigate back to the originating message. The full `/app` dashboard adds cross-session search, topic generations, learning, research, artifacts, runs, settings, backup/restore/export, and session controls.

User-authored dashboard writes may enter shared scopes directly. Agent-authored shared/high-impact writes wait for review; the observer's scope placement is also constrained by evidence and attribution. Agent forget asks permission and is scope-bounded. Dashboard forget is a confirmed user action and globally suppresses selected content.

See [User guide](docs/user-guide.md).

## Documentation

- [Installation, updates, uninstall, and paths](docs/getting-started.md)
- [Configuration reference and safe examples](docs/configuration.md)
- [Memory tab and dashboard user guide](docs/user-guide.md)
- [Architecture, data model, scopes, security, and privacy](docs/architecture-security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development, desktop fork, contribution, and release readiness](docs/development.md)
- [Complete project and feature guide (PDF)](docs/OpenCode-Memory-Project-Documentation.pdf)
- [Complete project and feature guide (Word)](docs/OpenCode-Memory-Project-Documentation.docx)

## Verify the workspace

```sh
bun run build
bun run typecheck
bun run --cwd packages/dashboard typecheck
bun test packages/core packages/plugin packages/evals
bun test packages/dashboard/test
bun run test:node:core
bun run test:node
```

`test:node` consumes the built plugin, so run `bun run build` first. Hermetic acceptance coverage lives in `packages/evals/test`. `bun run eval:real -- --dry-run` validates the opt-in real-provider eval without making a network/model call; a live run requires explicit confirmation, a running OpenCode server, and a cost cap. See [Development](docs/development.md#evaluations).

Contributor commands, the package map, desktop checks, rebase workflow, and safety checklist are in [Development](docs/development.md).

## Security summary

The HTTP server binds only `127.0.0.1`, checks `Host` and `Origin`, rejects CORS preflights, requires `X-OM-Token` for `/api/*`, and serves token-bearing HTML with no-store and a restrictive CSP. Capture and vault writes redact known secret formats. Agent and user actions have different trust and scope rules.

These are defense-in-depth controls, not a sandbox: a process running as the same OS user can read local files or fetch `/app` and recover its embedded token; pattern-based redaction can miss secrets; configured model/embedding endpoints receive redacted text; and backup erasure can remain pending after forget. Read the complete [security and privacy model](docs/architecture-security.md#security-and-privacy-invariants) before using sensitive material.
