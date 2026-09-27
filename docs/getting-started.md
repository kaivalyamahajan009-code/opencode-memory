# Installation and local paths

## Prerequisites

- Bun for development, builds, typechecks, and Bun tests.
- Node.js 24 for `scripts/install-local.mjs`, `node:sqlite`, and the Node compatibility checks.
- A local OpenCode installation.

This repository installs from its checkout; it does not publish or copy a global package.

## Install

```sh
git clone <repository-url> opencode-memory
cd opencode-memory
bun install
bun run build
node scripts/install-local.mjs
```

The root build runs the dashboard build first, then bundles the plugin and copies the dashboard into `packages/plugin/dist/dashboard`. The installer registers `packages/plugin/dist/index.js` as an absolute `file:` URL.

If the plugin build is missing, the installer prints a warning but still edits OpenCode's config. Build before restarting OpenCode.

### OpenCode config selected by the installer

`OPENCODE_CONFIG_DIR` wins. Otherwise the directory is:

- Windows: `%XDG_CONFIG_HOME%\opencode`, or `%USERPROFILE%\.config\opencode`
- macOS: `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`
- Linux: `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`

In the normal global directory, the installer uses the first existing file in this order:

1. `opencode.jsonc`
2. `opencode.json`
3. `config.json`

If none exists it creates `opencode.json`. With `OPENCODE_CONFIG_DIR`, only `opencode.jsonc` and `opencode.json` are considered; if neither exists, a new install creates `opencode.jsonc`.

Existing JSONC comments and trailing commas are preserved. A changed existing file is copied to `<file>.bak-<ISO timestamp>` first. The resulting entry resembles:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/opencode-memory/packages/plugin/dist/index.js"
  ]
}
```

Do not copy that sample URL literally; the installer generates the correct platform URL.

## First run

1. Restart OpenCode after installation.
2. Open a normal (non-worker) session in a project.
3. Run `/memory-status`.
4. Send messages or use tools. Fixed buffer chunks queue durably; the observer runs at activation, on idle/max-age recovery, or immediately with **Flush now**.
5. Open `http://127.0.0.1:4777/app`.

The first plugin process creates the SQLite database and token and serves the dashboard. Other OpenCode windows share the same database. The dashboard may initially be empty until completed session messages are captured and an observation run succeeds.

## Update

From the same checkout:

```sh
git pull
bun install
bun run build
```

Restart all OpenCode windows that loaded the plugin. The file URL in OpenCode's config remains valid.

If the checkout moved, run the old checkout's uninstall command before moving it when possible, then run the installer in the new checkout. The uninstall script removes only the exact file URL for its current checkout; it cannot identify a stale URL from another path.

## Uninstall

```sh
node scripts/install-local.mjs --uninstall
```

This removes the current checkout's plugin entry and backs up a changed existing OpenCode config. It does not remove:

- `~/.config/opencode-memory/config.json`
- `memory.db`, its WAL/SHM files, or the token
- the Markdown vault
- backups
- the source checkout

For complete removal, close every OpenCode process first, preserve any export you need, then remove the memory config and data directories listed below. Do not delete `memory.db-wal` or `memory.db-shm` while any process has the database open.

## Configuration and data paths

### Memory config

`$XDG_CONFIG_HOME/opencode-memory/config.json`, or:

- Windows: `%USERPROFILE%\.config\opencode-memory\config.json`
- macOS: `~/.config/opencode-memory/config.json`
- Linux: `~/.config/opencode-memory/config.json`

Unlike the installer, the memory config has no `OPENCODE_CONFIG_DIR` override.

### Data

`OPENCODE_MEMORY_DATA_DIR` wins. Otherwise the root is `$XDG_DATA_HOME/opencode-memory`, or:

- Windows: `%USERPROFILE%\.local\share\opencode-memory`
- macOS: `~/.local/share/opencode-memory`
- Linux: `~/.local/share/opencode-memory`

The implementation deliberately uses these XDG-style fallbacks on every OS; it does not use `%APPDATA%` or `~/Library/Application Support`.

Files below the data root:

- `memory.db` — live SQLite database.
- `memory.db-wal`, `memory.db-shm` — SQLite sidecars while applicable.
- `token` — 64-hex-character local API token, created on first start.
- `vault/` — default generated Markdown vault.
- `backups/` — timestamped `memory-YYYYMMDD-HHMMSS.db` backups.

`config.dataDir` can override the database/token/backup root. `config.vaultDir` can place the vault elsewhere. If `dataDir` is set and `vaultDir` is omitted, the vault defaults to `<dataDir>/vault`.

On POSIX, the implementation attempts `0700` on its private directories and `0600` on the database, token, and backup files when it owns them. Windows access is governed by the account and filesystem ACLs.

## Per-project file

Create `<project>/.opencode/memory.json` when defaults are not suitable:

```json
{
  "workspace": "course-notes",
  "domain": "learning",
  "name": "Distributed Systems",
  "exclude": false
}
```

- `workspace`: sharing boundary; defaults to `personal-knowledge`.
- `domain`: `general`, `learning`, or `research`; invalid values become `general`.
- `name`: optional display name.
- `exclude`: when `true`, sessions from the project are excluded from capture.

Invalid or unreadable project JSON silently falls back to defaults. Restart/reopen the OpenCode project after changing it so its adapter is registered with the new metadata.

## Desktop integration

The plugin and `/app` dashboard work without the fork. To use the in-session Memory tab, build the sibling OpenCode fork described in [Development](development.md#desktop-fork).

The packaged renderer origin is `oc://renderer`, which is allowed by default. Development uses the exact origin in `ELECTRON_RENDERER_URL` (normally an electron-vite `http://localhost:<port>` URL). Add that exact origin to `allowedOrigins` in the memory config and restart OpenCode.
