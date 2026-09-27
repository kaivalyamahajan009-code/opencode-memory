import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs"
import { basename, join } from "node:path"
import { openDatabase, tryCheckpoint, type Database } from "./sqlite"
import { SCHEMA_VERSION, ensureSchema } from "./schema-sql"
import { applySuppressions, ftsOptimize } from "./forget"
import { bumpMemoryGeneration, ftsIndex, rebuildSuppressionShingles, suppressionGeneration, upsertSuppression, type SuppressionScope } from "./observations"
import { pruneOrphanEmbeddings } from "./embeddings"
import { enqueueTopic } from "./vault"
import { MemoryError, randomId, safeJson } from "./util"

const EXCLUDED = new Set(["meta", "instances", "commands", "runtime_state", "jobs", "suppressions", "suppression_shingles"])
/** A restorable backup has rows in at least one of these. */
const CORE_TABLES = ["sessions", "observations", "topics"]
const MARKER_KEY = "backup_of"
/** Watermark of a file without a backup marker (writing a marker would make it restorable). */
const WATERMARK_KEY = "suppression_watermark"
const SCRUB_KEY = "scrub_pending"
const WAL_KEY = "wal_truncate_pending"
const FILE_NAME = /^memory-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/
const SCRUB_LEASE_MS = 10 * 60_000
const SCRUB_RETRY_MS = 60_000
const SCRUB_RETRY_MAX_MS = 60 * 60_000
/** Passes over backups that appeared while a scrub ran (another handle's backupNow). */
const SCRUB_PASSES = 3

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")
}

/** Creation time from the file name; mtime is not used for ordering (scrubbing rewrites files). */
function stampTime(file: string): number | undefined {
  const m = file.match(FILE_NAME)
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const t = Date.UTC(y, mo - 1, d, h, mi, s)
  return Number.isFinite(t) ? t : undefined
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function yieldLoop(): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 0)
    t.unref?.()
  })
}

export function backupDir(dataDir: string): string {
  return join(dataDir, "backups")
}

export type BackupInfo = { file: string; path: string; size: number; createdAt: number }

/** Newest first, by the timestamp in the file name. */
export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupDir(dataDir)
  if (!existsSync(dir)) return []
  const out: BackupInfo[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".db")) continue
    try {
      const s = statSync(join(dir, f))
      if (s.isFile()) out.push({ file: f, path: join(dir, f), size: s.size, createdAt: stampTime(f) ?? s.mtimeMs })
    } catch {}
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || b.file.localeCompare(a.file))
}

function tableNames(db: Database, schema: string): Set<string> {
  return new Set(
    db
      .prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`)
      .all<{ name: string }>()
      .map((t) => t.name),
  )
}

function rowCount(db: Database, schema: string, table: string): number {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.${table}`).get<{ n: number }>()?.n ?? 0
}

/**
 * Marker written into every backup: restore refuses files without it (e.g. an empty database).
 * Its watermark is the suppression generation inside the snapshot itself, so a forget that
 * commits while the backup is taken is never counted as applied.
 */
function markBackup(db: Database, path: string, now: number) {
  db.exec(`ATTACH DATABASE ${sqlString(path)} AS om_new_backup`)
  try {
    const have = tableNames(db, "om_new_backup")
    const counts = Object.fromEntries(CORE_TABLES.filter((t) => have.has(t)).map((t) => [t, rowCount(db, "om_new_backup", t)]))
    const watermark = suppressionGeneration(db, "om_new_backup")
    db.prepare("INSERT OR REPLACE INTO om_new_backup.meta(key, value) VALUES (?, ?)").run(
      MARKER_KEY,
      JSON.stringify({ of: basename(db.path), createdAt: now, counts, watermark }),
    )
  } finally {
    db.exec("DETACH DATABASE om_new_backup")
  }
}

function watermarkIn(db: Database, schema: string): number | undefined {
  const rows = db.prepare(`SELECT key, value FROM ${schema}.meta WHERE key IN (?, ?)`).all<{ key: string; value: string }>(MARKER_KEY, WATERMARK_KEY)
  const marker = rows.find((r) => r.key === MARKER_KEY)
  const raw = marker ? safeJson<{ watermark?: unknown }>(marker.value, {}).watermark : Number(rows.find((r) => r.key === WATERMARK_KEY)?.value)
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined
}

function stampWatermark(bak: Database, watermark: number) {
  const marker = bak.prepare("SELECT value FROM meta WHERE key = ?").get<{ value: string }>(MARKER_KEY)
  if (marker)
    bak.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ ...safeJson<Record<string, unknown>>(marker.value, {}), watermark }), MARKER_KEY)
  else bak.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(WATERMARK_KEY, String(watermark))
}

/**
 * The suppression generation a backup was made or last scrubbed at; undefined when unknown
 * (made before watermarks, unreadable, or busy for more than a moment). Call outside a transaction.
 */
export function backupWatermark(db: Database, path: string): number | undefined {
  if (!existsSync(path)) return undefined
  const alias = "om_watermark"
  const prev = Number(Object.values(db.prepare("PRAGMA busy_timeout").get<Record<string, number>>() ?? {})[0] ?? 0)
  try {
    db.exec("DETACH DATABASE om_watermark")
  } catch {}
  try {
    db.exec("PRAGMA busy_timeout = 250")
    db.exec(`ATTACH DATABASE ${sqlString(path)} AS ${alias}`)
    try {
      return tableNames(db, alias).has("meta") ? watermarkIn(db, alias) : undefined
    } finally {
      db.exec(`DETACH DATABASE ${alias}`)
    }
  } catch {
    return undefined
  } finally {
    try {
      db.exec(`PRAGMA busy_timeout = ${Number.isFinite(prev) ? prev : 0}`)
    } catch {}
  }
}

export type WatermarkCache = Map<string, { key: string; watermark: number | undefined }>

/**
 * Backups whose watermark is behind the live suppression generation, or unknown: they may hold
 * content forgotten since (including files another handle created while a forget committed).
 * A cache keyed by size/mtime/ctime avoids reopening unchanged files; drop it after a scrub.
 */
export function staleBackups(db: Database, dataDir: string, cache?: WatermarkCache): string[] {
  const gen = suppressionGeneration(db)
  const out: string[] = []
  const seen = new Set<string>()
  for (const b of listBackups(dataDir)) {
    let key: string
    try {
      const st = statSync(b.path)
      key = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`
    } catch {
      continue
    }
    seen.add(b.file)
    let hit = cache?.get(b.file)
    if (!hit || hit.key !== key) {
      hit = { key, watermark: backupWatermark(db, b.path) }
      cache?.set(b.file, hit)
    }
    if (hit.watermark === undefined || hit.watermark < gen) out.push(b.file)
  }
  if (cache) for (const f of [...cache.keys()]) if (!seen.has(f)) cache.delete(f)
  return out
}

export function backupNow(db: Database, dataDir: string, keep: number, now = Date.now()): string {
  const dir = backupDir(dataDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `memory-${stamp(now)}.db`)
  if (existsSync(path)) return path
  db.exec(`VACUUM INTO ${sqlString(path)}`)
  try {
    markBackup(db, path, now)
  } catch (e) {
    try {
      unlinkSync(path)
    } catch {}
    throw e
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600)
    } catch {}
  }
  for (const old of listBackups(dataDir).slice(Math.max(1, keep))) {
    try {
      unlinkSync(old.path)
    } catch {}
  }
  return path
}

export function autoBackup(db: Database, dataDir: string, keep: number, now = Date.now()): string | undefined {
  const latest = listBackups(dataDir)[0]
  if (latest && now - latest.createdAt < 24 * 3_600_000) return undefined
  return backupNow(db, dataDir, keep, now)
}

function columns(db: Database, schema: string, table: string): string[] {
  return db
    .prepare(`PRAGMA ${schema}.table_info(${table})`)
    .all<{ name: string }>()
    .map((c) => c.name)
}

function workspaceScopeKeys(db: Database, workspace: string): string[] {
  const projects = db.prepare("SELECT id FROM projects WHERE workspace = ?").all<{ id: string }>(workspace)
  return [`workspace:${workspace}`, ...projects.map((p) => `project:${p.id}`)]
}

type SuppressionRow = { kind: string; value: string; shingles?: string | null; reason?: string | null; created_at?: number | null; scope?: string | null }

/** Union into the live suppressions (scopes widened, any global entry wins), whatever columns the source has. */
function mergeSuppressions(db: Database, rows: SuppressionRow[], now: number) {
  for (const s of rows) {
    if (!s.kind || !s.value) continue
    const shingles = safeJson<unknown>(s.shingles ?? null, null)
    const scope = safeJson<unknown>(s.scope ?? null, null)
    upsertSuppression(db, {
      kind: s.kind,
      value: s.value,
      shingles: Array.isArray(shingles) ? (shingles as string[]) : null,
      reason: s.reason ?? null,
      createdAt: s.created_at ?? now,
      scope: Array.isArray(scope) ? (scope as SuppressionScope[]) : null,
    })
  }
}

function readSuppressions(db: Database, schema: string): SuppressionRow[] {
  const wanted = ["kind", "value", "shingles", "reason", "created_at", "scope"]
  const have = new Set(columns(db, schema, "suppressions"))
  const cols = wanted.filter((c) => have.has(c))
  if (!cols.includes("kind") || !cols.includes("value")) return []
  return db.prepare(`SELECT ${cols.join(",")} FROM ${schema}.suppressions`).all<SuppressionRow>()
}

// ---------- WAL truncation ----------

/** Record, inside the transaction that forgot content, that the WAL must be emptied of its old frames. */
export function markWalTruncate(db: Database, now = Date.now()) {
  db.prepare("INSERT OR REPLACE INTO runtime_state(key, value, until, updated_at) VALUES (?, NULL, NULL, ?)").run(WAL_KEY, now)
}

export function walTruncatePending(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM runtime_state WHERE key = ?").get(WAL_KEY)
}

/**
 * Checkpoint(TRUNCATE) so frames holding forgotten bytes leave memory.db-wal. Waits at most
 * busyMs on other connections; while they keep it busy the flag stays set for the next try.
 */
export function truncateWal(db: Database, busyMs = 200): boolean {
  if (!tryCheckpoint(db, "TRUNCATE", busyMs)) return false
  db.prepare("DELETE FROM runtime_state WHERE key = ?").run(WAL_KEY)
  tryCheckpoint(db, "TRUNCATE", busyMs)
  return true
}

// ---------- restore ----------

export type RestoreOptions = {
  /** Restore a file without the backup marker or without any core rows. Never exposed over HTTP. */
  force?: boolean
}

export type RestoreResult = { tables: number; suppressed: { observations: number; parts: number } }

type OutboxRow = {
  rel_path: string
  topic_id: string | null
  generation: number | null
  content: string
  hash: string
  force: number
  created_at: number
  attempts: number | null
  next_attempt_at: number | null
  error: string | null
}

/** Live vault deletes and forced rewrites that have not reached the disk yet: forgotten content may still be there. */
function pendingVaultRemovals(db: Database): OutboxRow[] {
  return db
    .prepare(
      `SELECT rel_path, topic_id, generation, content, hash, force, created_at, attempts, next_attempt_at, error
       FROM main.vault_outbox WHERE state = 'pending' AND (content = '' OR force = 1) ORDER BY id`,
    )
    .all<OutboxRow>()
}

/** Deletes are carried as-is; a forced rewrite of a topic the backup also has is re-queued from it later. */
function carryVaultRemovals(db: Database, rows: OutboxRow[]) {
  const ins = db.prepare(
    `INSERT INTO vault_outbox(rel_path, topic_id, generation, content, hash, state, force, created_at, attempts, next_attempt_at, error)
     VALUES (?,?,?,?,?, 'pending', ?,?,?,?,?)`,
  )
  for (const r of rows) {
    if (r.content && r.topic_id && db.prepare("SELECT 1 FROM topics WHERE id = ?").get(r.topic_id)) continue
    ins.run(r.rel_path, r.topic_id, r.generation, r.content, r.hash, r.force, r.created_at, r.attempts ?? 0, r.next_attempt_at, r.error)
  }
}

/** After suppressions are re-applied: files the live vault was rewriting or removing get the restored (sanitized) topic, forced. */
function requeueCarriedTopics(db: Database, rows: OutboxRow[], now: number) {
  const topics = new Set<string>()
  for (const r of rows) {
    if (r.content && r.topic_id) topics.add(r.topic_id)
    if (!r.content) {
      const t = db.prepare("SELECT id FROM topics WHERE rel_path = ? AND state != 'deleted'").get<{ id: string }>(r.rel_path)
      if (t) topics.add(t.id)
    }
  }
  for (const id of topics) enqueueTopic(db, id, now, true)
}

/**
 * Logical restore into the live database (connections held by other instances stay valid).
 * Columns are intersected with the live schema (older backups restore; missing columns take
 * their defaults) and live tables absent from the backup are emptied. Suppressions are the
 * union of live and backup, and are re-applied afterwards so forgotten content never comes back;
 * pending vault deletes and forced rewrites are carried over, and orphan vectors pruned.
 *
 * Refusals are MemoryErrors with user-safe messages (no paths): 400 when the file is missing or
 * empty, 409 when it is not a (marked, non-empty) backup of a supported schema.
 */
export function restoreBackup(db: Database, file: string, opts: RestoreOptions = {}, now = Date.now()): RestoreResult {
  let size = 0
  try {
    const s = statSync(file)
    size = s.isFile() ? s.size : 0
  } catch {}
  if (!size) throw new MemoryError("backup file is missing or empty", "invalid", 400)
  const refuse = (message: string) => new MemoryError(message, "conflict", 409)
  const notSqlite = (e: unknown) => (/not a database|encrypted|malformed/i.test(String((e as Error)?.message ?? e)) ? refuse("not an opencode-memory backup") : e)
  try {
    db.exec(`ATTACH DATABASE ${sqlString(file)} AS bak`)
  } catch (e) {
    const mapped = notSqlite(e)
    throw mapped instanceof MemoryError ? mapped : refuse("backup could not be opened")
  }
  let count = 0
  let suppressed = { observations: 0, parts: 0 }
  try {
    let bakTables: Set<string>
    try {
      bakTables = tableNames(db, "bak")
    } catch (e) {
      throw notSqlite(e)
    }
    if (!bakTables.has("meta")) throw refuse("not an opencode-memory backup")
    const v = db.prepare("SELECT value FROM bak.meta WHERE key = 'schema_version'").get<{ value: string }>()
    if (!v || !(Number(v.value) <= SCHEMA_VERSION)) throw refuse(`backup schema ${v?.value ?? "?"} is not supported (current ${SCHEMA_VERSION})`)
    if (!opts.force) {
      if (!db.prepare("SELECT 1 FROM bak.meta WHERE key = ?").get(MARKER_KEY)) throw refuse("refusing to restore: the file has no backup marker")
      const rows = CORE_TABLES.filter((t) => bakTables.has(t)).reduce((n, t) => n + rowCount(db, "bak", t), 0)
      if (!rows) throw refuse("refusing to restore: the backup has no sessions, observations or topics")
    }
    const tables = [...tableNames(db, "main")].filter((t) => !t.startsWith("sqlite_") && !t.startsWith("observations_fts") && !EXCLUDED.has(t))
    const bakSuppressions = bakTables.has("suppressions") ? readSuppressions(db, "bak") : []
    db.tx(() => {
      const removals = pendingVaultRemovals(db)
      for (const t of tables) {
        db.exec(`DELETE FROM main.${t}`)
        if (!bakTables.has(t)) continue
        const live = new Set(columns(db, "main", t))
        const cols = columns(db, "bak", t).filter((c) => live.has(c))
        if (!cols.length) continue
        db.exec(`INSERT INTO main.${t} (${cols.join(",")}) SELECT ${cols.join(",")} FROM bak.${t}`)
        count++
      }
      carryVaultRemovals(db, removals)
      mergeSuppressions(db, bakSuppressions, now)
      rebuildSuppressionShingles(db)
      db.exec("UPDATE main.jobs SET state = 'idle', lease_owner = NULL, lease_expires_at = NULL")
      db.exec("UPDATE main.chunks SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL WHERE state = 'running'")
      suppressed = applySuppressions(db, now)
      requeueCarriedTopics(db, removals, now)
      pruneOrphanEmbeddings(db)
      rebuildFts(db)
      markWalTruncate(db, now)
      bumpMemoryGeneration(db)
    })
  } catch (e) {
    if (e instanceof MemoryError) throw e
    throw refuse("backup could not be restored")
  } finally {
    try {
      db.exec("DETACH DATABASE bak")
    } catch {}
  }
  return { tables: count, suppressed }
}

/** Reindex live rows; optimize merges segments so deleted tokens leave the FTS blobs. */
export function rebuildFts(db: Database) {
  if (!db.hasFts5) return
  db.tx(() => {
    db.exec("DELETE FROM observations_fts")
    const rows = db.prepare("SELECT id, content, kind FROM observations WHERE status != 'forgotten'").all<{ id: string; content: string; kind: string }>()
    for (const r of rows) ftsIndex(db, r.id, r.content, r.kind)
  })
  ftsOptimize(db, { always: true })
}

// ---------- backup scrubbing ----------

type PendingState = { files: string[] | null; attempts: number; token: string; error?: string }

export type ScrubPending = { files: string[] | null; attempts: number; dueAt: number; error?: string }

function readPending(db: Database): (PendingState & { until: number }) | undefined {
  const row = db.prepare("SELECT value, until FROM runtime_state WHERE key = ?").get<{ value: string | null; until: number | null }>(SCRUB_KEY)
  if (!row) return undefined
  const v = safeJson<Partial<PendingState>>(row.value, {})
  return {
    files: Array.isArray(v.files) ? v.files.filter((f): f is string => typeof f === "string") : null,
    attempts: typeof v.attempts === "number" ? v.attempts : 0,
    token: typeof v.token === "string" ? v.token : "",
    error: typeof v.error === "string" ? v.error : undefined,
    until: row.until ?? 0,
  }
}

function writePending(db: Database, s: PendingState, until: number, now: number) {
  db.prepare("INSERT OR REPLACE INTO runtime_state(key, value, until, updated_at) VALUES (?,?,?,?)").run(SCRUB_KEY, JSON.stringify(s), until, now)
}

/** Backups that still have to be scrubbed (files null = all), persisted across restarts. */
export function scrubPending(db: Database): ScrubPending | undefined {
  const p = readPending(db)
  return p && { files: p.files, attempts: p.attempts, dueAt: p.until, error: p.error }
}

/**
 * Record that backups must be scrubbed (files null = all). Call it inside the forget's
 * transaction so a crash or throw right after the commit still leaves the marker for open/tick.
 */
export function markScrubPending(db: Database, files: string[] | null, now = Date.now()) {
  const prev = readPending(db)
  const merged = !files || (prev && prev.files === null) ? null : [...new Set([...(prev?.files ?? []), ...files])]
  writePending(db, { files: merged, attempts: prev?.attempts ?? 0, token: randomId("mark") }, now, now)
}

/** The pending scrub, when a retry is due now; undefined when there is nothing to do yet. */
export function dueScrub(db: Database, now = Date.now()): ScrubPending | undefined {
  const p = scrubPending(db)
  return p && p.dueAt <= now ? p : undefined
}

/** Backups waiting out a failure backoff (null = all of them). */
export function backedOffBackups(db: Database, now = Date.now()): Set<string> | null {
  const p = scrubPending(db)
  if (!p || p.dueAt <= now) return new Set()
  return p.files ? new Set(p.files) : null
}

type FileOutcome = "scrubbed" | "missing" | "aborted"

/**
 * Apply the given suppressions inside one backup and stamp the generation they reflect. The
 * watermark is written only after VACUUM, so an interrupted scrub leaves the file stale (and
 * retried). Yields to the event loop between phases; an abort stops at the next phase.
 */
async function scrubFile(path: string, sup: SuppressionRow[], watermark: number, now: number, signal?: AbortSignal): Promise<FileOutcome> {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    throw e
  }
  if (!st.isFile() || st.size === 0) return "missing"
  const bak = await openDatabase(path, { create: false })
  try {
    if (!bak.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get()) return "missing"
    ensureSchema(bak)
    await yieldLoop()
    if (signal?.aborted) return "aborted"
    bak.tx(() => {
      mergeSuppressions(bak, sup, now)
      applySuppressions(bak, now)
      pruneOrphanEmbeddings(bak)
      rebuildFts(bak)
    })
    await yieldLoop()
    if (signal?.aborted) return "aborted"
    bak.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    bak.exec("VACUUM")
    stampWatermark(bak, watermark)
    bak.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    bak.close()
  }
  try {
    utimesSync(path, st.atime, st.mtime)
  } catch {}
  return "scrubbed"
}

export type ScrubResult = { scrubbed: number; failed: string[]; skipped: number; aborted?: boolean }

export type ScrubOptions = {
  /** Only these backup file names (a retry); default all. */
  files?: string[]
  signal?: AbortSignal
  log?: (level: "warn", msg: string) => void
  now?: () => number
}

/**
 * Apply live suppressions inside backups so a later restore cannot resurrect forgotten
 * content. Each file is independent: a failure is logged and recorded in runtime_state
 * ('scrub_pending') for a retry with backoff; missing files are skipped, never recreated;
 * file order (names) and mtimes are preserved. Each scrubbed file records the suppression
 * generation it now reflects; files that appeared during the pass and are behind it are
 * scrubbed too. Yields to the event loop between files and between the phases of a file.
 */
export async function scrubBackups(db: Database, dataDir: string, opts: ScrubOptions = {}): Promise<ScrubResult> {
  const clock = opts.now ?? Date.now
  const res: ScrubResult = { scrubbed: 0, failed: [], skipped: 0 }
  const all = listBackups(dataDir)
  const wanted = opts.files ? new Set(opts.files) : undefined
  let backups = wanted ? all.filter((b) => wanted.has(b.file)) : all
  const prev = readPending(db)
  const token = randomId("scrub")
  const tracked = !wanted || (prev && prev.files === null) ? null : [...new Set([...(prev?.files ?? []), ...wanted])]
  writePending(db, { files: tracked, attempts: prev?.attempts ?? 0, token }, clock() + SCRUB_LEASE_MS, clock())
  const gen = suppressionGeneration(db)
  const sup = readSuppressions(db, "main")
  const ok = new Set<string>()
  const attempted = new Set<string>()
  const known = new Set(all.map((b) => b.file))
  let lastError: string | undefined
  for (let pass = 0; pass < SCRUB_PASSES && backups.length && !res.aborted; pass++) {
    for (const b of backups) {
      attempted.add(b.file)
      await yieldLoop()
      if (opts.signal?.aborted) {
        res.aborted = true
        break
      }
      try {
        const outcome = await scrubFile(b.path, sup, gen, clock(), opts.signal)
        if (outcome === "aborted") {
          res.aborted = true
          break
        }
        if (outcome === "missing") res.skipped++
        else res.scrubbed++
        ok.add(b.file)
      } catch (e) {
        lastError = `${b.file}: ${String((e as Error)?.message ?? e)}`
        res.failed.push(b.file)
        opts.log?.("warn", `backup scrub failed for ${lastError}`)
      }
    }
    if (res.aborted) break
    backups = listBackups(dataDir).filter((b) => !known.has(b.file) && !attempted.has(b.file) && !((backupWatermark(db, b.path) ?? -1) >= gen))
    for (const b of backups) known.add(b.file)
  }
  const present = new Set(listBackups(dataDir).map((b) => b.file))
  const outstanding = (tracked ?? [...new Set([...all.map((b) => b.file), ...attempted])]).filter((f) => present.has(f) && !ok.has(f))
  const now = clock()
  const cur = readPending(db)
  if (cur && cur.token !== token) {
    if (outstanding.length && cur.files) writePending(db, { ...cur, files: [...new Set([...cur.files, ...outstanding])] }, cur.until, now)
  } else if (outstanding.length) {
    const attempts = (cur?.attempts ?? prev?.attempts ?? 0) + (res.failed.length ? 1 : 0)
    const delay = res.failed.length ? Math.min(SCRUB_RETRY_MAX_MS, SCRUB_RETRY_MS * 2 ** Math.max(0, attempts - 1)) : 0
    writePending(db, { files: outstanding, attempts, token, error: lastError }, now + delay, now)
  } else {
    db.prepare("DELETE FROM runtime_state WHERE key = ? AND value LIKE ?").run(SCRUB_KEY, `%${token}%`)
  }
  return res
}

export function exportJson(db: Database, filter: { workspace?: string } = {}) {
  const where = filter.workspace ? "WHERE workspace = ?" : ""
  const params = filter.workspace ? [filter.workspace] : []
  const scopeKeys = filter.workspace ? workspaceScopeKeys(db, filter.workspace) : []
  const topicWhere = scopeKeys.length ? `WHERE scope_key IN (${scopeKeys.map(() => "?").join(",")})` : ""
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    observations: db
      .prepare(`SELECT * FROM observations ${where ? `${where} AND` : "WHERE"} status NOT IN ('forgotten','rejected')`)
      .all<any>(...params),
    topics: db
      .prepare(`SELECT id, scope_key, slug, title, summary, body, generation, approved, updated_at FROM topics ${topicWhere}`)
      .all<any>(...scopeKeys),
    journey: db.prepare(`SELECT * FROM journey_entries ${topicWhere} ORDER BY at`).all<any>(...scopeKeys),
    concepts: db.prepare(`SELECT * FROM learning_concepts ${where}`).all<any>(...params),
    claims: db.prepare(`SELECT * FROM research_claims ${where}`).all<any>(...params),
    sources: db.prepare(`SELECT * FROM research_sources ${where}`).all<any>(...params),
    artifacts: db
      .prepare(`SELECT id, workspace, project_id, path, kind, origin, hash, title, concepts, created_at FROM artifacts ${where}`)
      .all<any>(...params),
  }
}
