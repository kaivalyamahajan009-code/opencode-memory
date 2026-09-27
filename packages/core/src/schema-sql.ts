import type { Database } from "./sqlite"
import { rebuildSuppressionShingles } from "./observations"

const V1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  domain TEXT,
  name TEXT,
  directory TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT,
  internal INTEGER NOT NULL DEFAULT 0,
  internal_source TEXT,
  excluded INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  revert_message_id TEXT,
  fork_source TEXT,
  fork_boundary_seq INTEGER,
  fork_boundary_message_id TEXT,
  last_activity_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS sessions_fork_boundary ON sessions(fork_source, fork_boundary_message_id);

-- Retained, redacted source snapshot. Exact recall reads from here.
CREATE TABLE IF NOT EXISTS source_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  captured_at INTEGER NOT NULL,
  hash TEXT NOT NULL,
  token_est INTEGER NOT NULL,
  flags TEXT,
  status TEXT NOT NULL DEFAULT 'present',
  UNIQUE(session_id, seq)
);

CREATE TABLE IF NOT EXISTS source_parts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool TEXT,
  text TEXT NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  omitted INTEGER NOT NULL DEFAULT 0,
  flags TEXT,
  hash TEXT NOT NULL,
  transform_version INTEGER NOT NULL,
  suppressed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS source_parts_message ON source_parts(message_id, ord);

-- Ingestion watermark (content safely stored) and chunking watermark.
CREATE TABLE IF NOT EXISTS ingest_state (
  session_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0,
  chunked_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Observation jobs. state: pending | running | succeeded | retryable | quarantined | split | cancelled
-- cancel_reason (cancelled only): revert | exclude | forget | other; NULL is treated as other (never revived).
-- revert_seq: a succeeded chunk cut by a revert at this seq; its coverage comes back when the whole suffix does.
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  parent_id TEXT,
  token_est INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  error_class TEXT,
  next_attempt_at INTEGER,
  reason TEXT,
  part_ids TEXT,
  cancel_reason TEXT,
  revert_seq INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_claim ON chunks(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id, start_seq);

-- Exact source ranges successfully observed. A failure marker never appears here.
CREATE TABLE IF NOT EXISTS coverage (
  chunk_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  inherited_from TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS coverage_session ON coverage(session_id, start_seq);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT,
  workspace TEXT NOT NULL,
  chunk_id TEXT,
  kind TEXT NOT NULL,
  domain TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  event_at INTEGER,
  observed_at INTEGER NOT NULL,
  confidence REAL NOT NULL,
  evidence_type TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'visible',
  review_reason TEXT,
  target_scope TEXT,
  supersedes_id TEXT,
  superseded_by TEXT,
  expires_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  subject_key TEXT,
  from_recall INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  token_est INTEGER NOT NULL,
  actor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_scope ON observations(scope_kind, project_id, workspace, status);
CREATE INDEX IF NOT EXISTS observations_session ON observations(session_id, observed_at);
CREATE INDEX IF NOT EXISTS observations_hash ON observations(content_hash);
CREATE INDEX IF NOT EXISTS observations_subject ON observations(subject_key);

CREATE TABLE IF NOT EXISTS observation_sources (
  observation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  start_message_id TEXT NOT NULL,
  end_message_id TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  part_ids TEXT,
  transform_version INTEGER NOT NULL,
  PRIMARY KEY (observation_id, session_id, start_seq)
);
CREATE INDEX IF NOT EXISTS observation_sources_session ON observation_sources(session_id, start_seq);

-- Append-only lifecycle events.
CREATE TABLE IF NOT EXISTS observation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS observation_events_obs ON observation_events(observation_id);

CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY,
  current_task TEXT,
  suggested_next TEXT,
  chunk_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  data TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS review_items_state ON review_items(state, created_at);

-- Forget suppression. Stores hashes/ids only, never the forgotten text.
-- kind: content | part | observation | session | message
-- scope (content and observation kinds): NULL = global; else JSON [{"w": workspace, "p": projectId}] of the
-- scoped forgets that added it. Rows written before observation scopes were recorded stay NULL (global).
-- meta 'suppression_gen' counts suppression changes; backups record the value they were scrubbed at.
CREATE TABLE IF NOT EXISTS suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  shingles TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  scope TEXT,
  UNIQUE(kind, value)
);
CREATE INDEX IF NOT EXISTS suppressions_kind ON suppressions(kind, value);

CREATE TABLE IF NOT EXISTS suppression_shingles (
  shingle TEXT NOT NULL,
  suppression_id INTEGER NOT NULL,
  PRIMARY KEY (shingle, suppression_id)
);
CREATE INDEX IF NOT EXISTS suppression_shingles_lookup ON suppression_shingles(shingle);

CREATE TABLE IF NOT EXISTS jobs (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  error TEXT,
  next_attempt_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT,
  ref_id TEXT,
  runner TEXT,
  model TEXT,
  status TEXT NOT NULL,
  reserved_cost REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  error_class TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS operations_started ON operations(started_at);
CREATE INDEX IF NOT EXISTS operations_status_finished ON operations(status, finished_at);
CREATE INDEX IF NOT EXISTS operations_status_started ON operations(status, started_at);

CREATE TABLE IF NOT EXISTS runtime_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  memory_generation INTEGER NOT NULL,
  observation_ids TEXT NOT NULL,
  block TEXT NOT NULL,
  token_est INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS context_snapshots_session ON context_snapshots(session_id, created_at);

-- DB-mediated routing of dashboard actions to the plugin instance owning a directory.
-- state: pending | running | done | failed | expired. A running row whose lease expired is reclaimed.
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  directory TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  owner TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS commands_state ON commands(state, created_at);

-- Fork lineage recorded by the fork patch: old -> new message/part identity.
CREATE TABLE IF NOT EXISTS fork_map (
  target_session TEXT NOT NULL,
  source_session TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (target_session, source_id)
);
CREATE INDEX IF NOT EXISTS fork_map_target ON fork_map(target_session, target_id);
CREATE INDEX IF NOT EXISTS fork_map_source_session ON fork_map(source_session);
CREATE INDEX IF NOT EXISTS fork_map_source_id ON fork_map(source_id);
CREATE INDEX IF NOT EXISTS fork_map_target_id ON fork_map(target_id);

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  server_url TEXT,
  directory TEXT NOT NULL,
  project_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  input_ids TEXT NOT NULL,
  ops TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  slug TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT NOT NULL,
  generation INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  materialized_hash TEXT,
  materialized_generation INTEGER,
  state TEXT NOT NULL DEFAULT 'active',
  approved INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope_key, slug)
);

CREATE TABLE IF NOT EXISTS topic_generations (
  topic_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, generation)
);

CREATE TABLE IF NOT EXISTS vault_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path TEXT NOT NULL,
  topic_id TEXT,
  generation INTEGER,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  force INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  written_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS journey_entries (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  entry TEXT NOT NULL,
  refs TEXT
);

CREATE TABLE IF NOT EXISTS embeddings (
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (content_hash, model)
);

CREATE TABLE IF NOT EXISTS learning_concepts (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace, slug)
);

CREATE TABLE IF NOT EXISTS learning_attempts (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  session_id TEXT,
  question TEXT,
  answer TEXT,
  evaluation TEXT NOT NULL,
  hints INTEGER NOT NULL DEFAULT 0,
  independent INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS learning_attempts_concept ON learning_attempts(concept_id, at);

CREATE TABLE IF NOT EXISTS review_cards (
  concept_id TEXT PRIMARY KEY,
  card TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  last_review_at INTEGER,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  url TEXT,
  doi TEXT,
  title TEXT,
  published_at TEXT,
  accessed_at TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS research_claims (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  statement TEXT NOT NULL,
  statement_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  conditions TEXT,
  confidence REAL,
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace, statement_hash)
);

CREATE TABLE IF NOT EXISTS claim_evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  source_id TEXT,
  stance TEXT NOT NULL,
  quotation TEXT,
  locator TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  message_id TEXT,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  hash TEXT NOT NULL,
  title TEXT,
  concepts TEXT,
  content TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(path, hash)
);
`

const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  observation_id UNINDEXED,
  content,
  kind,
  tokenize = 'porter unicode61'
);
`

export const SCHEMA_VERSION = 1

const CREATE_TABLE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)["`\]]?\s*\(/i
const TABLE_CONSTRAINT = /^(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i

/** Split a DDL script into statements (quotes, `--` comments and trigger bodies respected). */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ""
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++
      buf += "\n"
      continue
    }
    if (ch === ";") {
      if (/^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(buf) && !/\bEND\s*$/i.test(buf)) {
        buf += ch
        continue
      }
      if (buf.trim()) out.push(buf.trim())
      buf = ""
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

function splitTopLevel(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let buf = ""
  for (const ch of body) {
    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch
    else if (ch === "(") depth++
    else if (ch === ")") depth--
    else if (ch === "," && depth === 0) {
      out.push(buf.trim())
      buf = ""
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/** Column definitions declared in a CREATE TABLE statement (table constraints skipped). */
export function declaredColumns(stmt: string): { name: string; def: string }[] {
  const body = stmt.slice(stmt.indexOf("(") + 1, stmt.lastIndexOf(")"))
  return splitTopLevel(body)
    .filter((part) => part && !TABLE_CONSTRAINT.test(part))
    .map((def) => ({ name: def.match(/^["`[]?(\w+)["`\]]?/)![1], def }))
}

function addColumn(db: Database, table: string, col: { name: string; def: string }) {
  const rest = col.def.replace(/^["`[]?\w+["`\]]?/, "")
  const where = `${table}.${col.name}`
  if (/\bPRIMARY\s+KEY\b/i.test(rest) || /\bUNIQUE\b/i.test(rest))
    throw new Error(`schema: cannot add column ${where} to an existing database: PRIMARY KEY/UNIQUE columns need a table rebuild`)
  if (/\bNOT\s+NULL\b/i.test(rest) && !/\bDEFAULT\b/i.test(rest))
    throw new Error(`schema: cannot add NOT NULL column ${where} to an existing database without a DEFAULT`)
  if (/\bDEFAULT\s*\(/i.test(rest) || /\bDEFAULT\s+CURRENT_(?:TIME|DATE|TIMESTAMP)\b/i.test(rest))
    throw new Error(`schema: cannot add column ${where} to an existing database: its DEFAULT is not a constant`)
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.def}`)
}

export function createFts(db: Database): void {
  if (!db.hasFts5) return
  db.exec(FTS)
  try {
    // SQLite >= 3.44: deletes remove tokens from the index instead of leaving tombstones.
    db.exec("INSERT INTO observations_fts(observations_fts, rank) VALUES('secure-delete', 1)")
  } catch {}
}

export type SchemaReport = { createdTables: string[]; addedColumns: string[] }

/**
 * Idempotent schema convergence, run on every open (live DB and backup files):
 * creates missing tables/indexes/triggers and adds columns declared in DDL but
 * missing from an older file. Only nullable or constant-DEFAULT columns can be added.
 */
export function ensureSchema(db: Database): SchemaReport {
  const report: SchemaReport = { createdTables: [], addedColumns: [] }
  const statements = splitStatements(V1)
  const tables = statements.filter((s) => CREATE_TABLE.test(s))
  const others = statements.filter((s) => !CREATE_TABLE.test(s))
  db.tx(() => {
    const existing = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all<{ name: string }>()
        .map((r) => r.name),
    )
    for (const stmt of tables) {
      const name = stmt.match(CREATE_TABLE)![1]
      if (!existing.has(name)) {
        db.exec(stmt)
        report.createdTables.push(name)
        continue
      }
      const have = new Set(
        db
          .prepare(`PRAGMA table_info(${name})`)
          .all<{ name: string }>()
          .map((c) => c.name.toLowerCase()),
      )
      for (const col of declaredColumns(stmt)) {
        if (have.has(col.name.toLowerCase())) continue
        addColumn(db, name, col)
        report.addedColumns.push(`${name}.${col.name}`)
      }
    }
    for (const stmt of others) db.exec(stmt)
    if (report.createdTables.includes("suppression_shingles") && existing.has("suppressions")) rebuildSuppressionShingles(db)
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get<{ value: string }>()
    if (!row || Number(row.value) < SCHEMA_VERSION)
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
  })
  createFts(db)
  return report
}

export function migrate(db: Database): void {
  ensureSchema(db)
}
