# Configuration

The memory service reads strict JSON from `~/.config/opencode-memory/config.json` (or `$XDG_CONFIG_HOME/opencode-memory/config.json`) when the first plugin instance starts. It deep-merges valid sections over defaults. Unknown top-level keys are ignored with a warning; an invalid section falls back as a whole. Restart all OpenCode windows after editing bind paths, port, origins, or endpoint credentials.

The dashboard can save a safe subset live. It cannot change `dataDir`, `vaultDir`, `port`, `allowedOrigins`, endpoint base URLs, API-key environment-variable names, or custom headers.

## Safe OpenCode-session example

```json
{
  "allowedOrigins": [
    "oc://renderer",
    "http://localhost:5173"
  ],
  "capture": {
    "captureReasoning": false,
    "observeSubagents": false
  },
  "observe": {
    "bufferTokens": 6000,
    "activationTokens": 30000,
    "maxChunkTokens": 12000,
    "minFlushTokens": 150,
    "idleFlushMs": 90000,
    "maxUnobservedAgeMs": 600000,
    "observerToolOutputMax": 4000,
    "maxAttempts": 3,
    "leaseMs": 300000,
    "concurrency": 1
  },
  "reflect": {
    "thresholdTokens": 40000,
    "minNewDurable": 25
  },
  "runner": {
    "kind": "opencode-session",
    "model": {
      "providerID": "your-provider",
      "modelID": "your-small-structured-output-model"
    },
    "timeoutMs": 180000
  },
  "reflectorRunner": {
    "kind": "opencode-session",
    "model": {
      "providerID": "your-provider",
      "modelID": "your-reflection-model"
    },
    "timeoutMs": 180000
  },
  "embeddings": {
    "provider": "none",
    "batchSize": 32
  },
  "inject": {
    "enabled": true,
    "deadlineMs": 250,
    "budget": {
      "profile": 600,
      "workspace": 900,
      "project": 900,
      "session": 2400,
      "task": 300,
      "recall": 900
    }
  },
  "cost": {
    "dailyCapUsd": 1,
    "dailyTokenCap": 2000000,
    "estimatePerRunUsd": 0.01
  },
  "pruning": {
    "enabled": false,
    "keepRecentTurns": 4
  },
  "backup": {
    "keep": 14,
    "autoDaily": true
  }
}
```

Replace the model identifiers with identifiers already configured in OpenCode. Omit `runner.model` to fall back to OpenCode's `small_model`, then the current session model. The reflector falls back to the observer runner/model when `reflectorRunner` is omitted.

The development renderer's port is not guaranteed. `http://localhost:5173` above is only an example; use the exact `window.location.origin` / `ELECTRON_RENDERER_URL` origin that desktop development actually loads.

## Direct runner example

The direct runner posts OpenAI-compatible chat-completion requests to `<baseURL>/chat/completions` and requests JSON-schema output.

```json
{
  "runner": {
    "kind": "direct",
    "timeoutMs": 180000,
    "direct": {
      "baseURL": "https://models.example.invalid/v1",
      "model": "observer-model",
      "apiKeyEnv": "OM_MODEL_API_KEY",
      "headers": {
        "x-tenant": "memory"
      },
      "inputCostPerMTok": 0.2,
      "outputCostPerMTok": 0.8
    }
  },
  "reflectorRunner": {
    "kind": "direct",
    "timeoutMs": 180000,
    "direct": {
      "baseURL": "https://models.example.invalid/v1",
      "model": "reflector-model",
      "apiKeyEnv": "OM_MODEL_API_KEY",
      "inputCostPerMTok": 0.2,
      "outputCostPerMTok": 0.8
    }
  }
}
```

Set the secret in the environment of the process that launches OpenCode:

```sh
OM_MODEL_API_KEY=replace-at-runtime
```

Use the platform's normal environment syntax; do not put the key value in config. Direct `baseURL` must be HTTPS, except HTTP is accepted for `127.0.0.1`, `localhost`, or `::1`. A missing key, missing direct block, or HTTP 401/403 pauses workers for authentication.

`direct.headers` adds endpoint-specific request headers. Custom headers are applied first; generated `Content-Type: application/json` and `Authorization: Bearer <api key>` are then set case-insensitively and cannot be overridden. Header names must be valid HTTP field names and cannot be `__proto__`, `constructor`, or `prototype`; values containing CR or LF are rejected.

## Optional embeddings

```json
{
  "embeddings": {
    "provider": "openai-compatible",
    "baseURL": "https://embeddings.example.invalid/v1",
    "model": "embedding-model",
    "apiKeyEnv": "OM_EMBEDDING_API_KEY",
    "headers": {
      "x-tenant": "memory"
    },
    "batchSize": 32
  }
}
```

The embedder posts to `<baseURL>/embeddings`. Redacted active/pending observation text is sent to that endpoint and vectors are stored in SQLite. Query embedding is bounded by half of `inject.deadlineMs`; search falls back to BM25 when no vector is available.

Embedding base URLs are not currently restricted to HTTPS/loopback. Treat the endpoint as trusted. `embeddings.headers` follows the same name/value safety rules and generated-content-type precedence as direct headers. When an embedding API key is available, its generated Bearer authorization overrides any custom `Authorization` header; without an API key, custom authorization is retained.

Custom header maps are sensitive config. The dashboard cannot change them, config responses mask every value as `***`, and header-validation errors do not include individual configured names or values.

## Defaults and options

### Storage and HTTP

- `dataDir`: `$OPENCODE_MEMORY_DATA_DIR`, else `$XDG_DATA_HOME/opencode-memory`, else `~/.local/share/opencode-memory`.
- `vaultDir`: `<dataDir>/vault`.
- `port`: `4777`; `0` validates but is not useful because host/origin checks and clients use the configured value.
- `allowedOrigins`: `["oc://renderer"]`. Entries are exact origins, not patterns. The service's own `http://127.0.0.1:<port>` and `http://localhost:<port>` origins are always accepted.

### Capture

- `capture.captureReasoning`: `false`; reasoning text is replaced by an omission marker.
- `capture.observeSubagents`: `false`; ordinary child/subagent sessions are excluded. Internal `om-*` worker sessions are always excluded.
- `capture.snapshotToolOutputMax`: `64000` characters per captured tool output before middle truncation.
- `capture.staleIncompleteMs`: `1800000`; incomplete assistant messages older than this may be captured.

All retained text is redacted before storage. Memory-tool outputs are represented by an omission marker to avoid recall loops.

### Observation

- `observe.bufferTokens`: `6000`; fixed durable chunks are queued at this boundary. A buffer cut alone does not start the model below activation.
- `observe.activationTokens`: `30000`; automatic buffer-driven observation starts when one session's total unobserved work reaches this value. The total includes pending, retryable, and running chunks plus the uncovered unchunked tail. `0` means immediate automatic activation.
- `observe.maxChunkTokens`: `12000`; upper target for one chunk.
- `observe.minFlushTokens`: `150`; minimum tail size for an idle cut. Explicit, age, and recovery cuts ignore it.
- `observe.idleFlushMs`: `90000`; idle delay before queued buffer chunks are activated and an eligible tail is cut, even below the activation threshold.
- `observe.maxUnobservedAgeMs`: `600000`; maximum age before queued work is activated and the whole tail is cut, even below the activation threshold.
- `observe.observerToolOutputMax`: `4000`; tool output included in observer input.
- `observe.maxAttempts`: `3`; repeated retryable failure eventually quarantines a chunk.
- `observe.leaseMs`: `300000`; worker lease, minimum `1000`.
- `observe.concurrency`: `1`.

`concurrency` is validated and stored, but the current engine drains a project through one single-flight loop; do not assume parallel observer runs from increasing it.

Explicit **Flush now** always bypasses activation and drains that session's queued chunks. Startup recovery also bypasses activation for sessions that were already idle/stale, so a small session is not stranded after a restart. Buffer chunks that have activated are marked ready in their existing durable rows; no separate activation state or schema migration is required.

### Reflection and injection

- `reflect.thresholdTokens`: `40000`.
- `reflect.minNewDurable`: `25`.

A project/workspace becomes due when either threshold is crossed by new active durable observations.

- `inject.enabled`: `true`.
- `inject.deadlineMs`: `250`. Two consecutive overruns cause a ten-minute per-session injection cooldown.
- `inject.budget`: token budgets for `profile` (user), `workspace`, `project`, `session`, `task`, and query `recall`.

The plugin injects a stable `<opencode-memory hash="…">` block and records the block actually sent.

### Cost

- `cost.dailyCapUsd`: `1`.
- `cost.dailyTokenCap`: `2000000`.
- `cost.estimatePerRunUsd`: `0.01`, reserved before each model run.

Caps reset at the start of the local day. `0` is not “unlimited”: with the defaults it prevents runs. Direct-runner cost comes from configured per-million-token prices; OpenCode-session cost comes from child-session usage.

### Pruning and backup

- `pruning.enabled`: `false`.
- `pruning.keepRecentTurns`: `4`.

Pruning removes already covered older messages from the model request, not from the retained memory source. Keep it disabled until its effect on your OpenCode workflow is understood.

- `backup.keep`: `14`. At least one backup is retained even if this is `0`.
- `backup.autoDaily`: `true`; maintenance checks hourly and creates a backup when the newest is at least 24 hours old.

The backup directory is fixed at `<dataDir>/backups`; there is no `backup.dir` option.

## Project configuration

`.opencode/memory.json`:

```json
{
  "workspace": "lab-notes",
  "domain": "research",
  "name": "Replication study",
  "exclude": false
}
```

The workspace is the sharing boundary. `domain` changes classification/focused UI but not the boundary. Learning concepts/cards and research claims/sources are currently keyed by workspace, not by project.

## Validation and live settings

`runner.timeoutMs`, `reflectorRunner.timeoutMs`, and `observe.leaseMs` must be at least `1000`. Most counts must be non-negative integers; `maxChunkTokens`, attempts, concurrency, and embedding batch size must be positive integers.

The dashboard Settings page can safely update common thresholds, model IDs, budgets, timers, cost caps, and pruning. It masks configured header values and strips sensitive/bind fields from writes. If `config.json` is invalid JSON or not an object, dashboard save refuses to modify it; fix the file first.
