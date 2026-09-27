import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs"
import { basename, dirname } from "node:path"

export type SqlValue = string | number | bigint | null | Uint8Array | boolean | undefined

const BUSY_TIMEOUT_MS = 8000
/** A WAL (or rollback journal) left behind is truncated to this size after a checkpoint resets it. */
const JOURNAL_SIZE_LIMIT = 4 * 1024 * 1024
export type Row = Record<string, any>

export interface Statement {
  run(...params: SqlValue[]): { changes: number }
  get<T = Row>(...params: SqlValue[]): T | undefined
  all<T = Row>(...params: SqlValue[]): T[]
}

export interface Database {
  readonly path: string
  readonly driver: "node" | "bun"
  readonly hasFts5: boolean
  exec(sql: string): void
  prepare(sql: string): Statement
  /** Runs fn inside BEGIN IMMEDIATE (or a savepoint when nested). fn must be synchronous. */
  tx<T>(fn: () => T): T
  close(): void
}

type RawStatement = {
  run(...params: any[]): any
  get(...params: any[]): any
  all(...params: any[]): any[]
}

type RawDatabase = {
  exec(sql: string): void
  close(): void
}

function bind(params: SqlValue[]): any[] {
  return params.map((p) => {
    if (p === undefined) return null
    if (typeof p === "boolean") return p ? 1 : 0
    return p
  })
}

class Wrapped implements Database {
  readonly hasFts5: boolean
  private readonly cache = new Map<string, Statement>()
  private depth = 0

  constructor(
    readonly path: string,
    readonly driver: "node" | "bun",
    private readonly raw: RawDatabase,
    private readonly prepareRaw: (sql: string) => RawStatement,
  ) {
    this.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (path !== ":memory:") this.exec("PRAGMA journal_mode = WAL")
    this.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`)
    this.exec("PRAGMA synchronous = NORMAL")
    this.exec("PRAGMA foreign_keys = ON")
    this.exec("PRAGMA secure_delete = ON")
    this.hasFts5 = this.probeFts5()
  }

  private probeFts5(): boolean {
    try {
      this.raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.__om_fts_probe USING fts5(x)")
      this.raw.exec("DROP TABLE IF EXISTS temp.__om_fts_probe")
      return true
    } catch {
      return false
    }
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  prepare(sql: string): Statement {
    const hit = this.cache.get(sql)
    if (hit) return hit
    const stmt = this.prepareRaw(sql)
    const wrapped: Statement = {
      run: (...params) => {
        const r = stmt.run(...bind(params))
        return { changes: Number(r?.changes ?? 0) }
      },
      get: (...params) => {
        const r = stmt.get(...bind(params))
        return r === null ? undefined : r
      },
      all: (...params) => stmt.all(...bind(params)),
    }
    this.cache.set(sql, wrapped)
    return wrapped
  }

  tx<T>(fn: () => T): T {
    const nested = this.depth > 0
    const sp = `om_sp_${this.depth}`
    this.exec(nested ? `SAVEPOINT ${sp}` : "BEGIN IMMEDIATE")
    this.depth++
    try {
      const result = fn()
      if (result && typeof (result as any).then === "function") {
        throw new Error("Database.tx callback must be synchronous")
      }
      this.depth--
      this.exec(nested ? `RELEASE ${sp}` : "COMMIT")
      return result
    } catch (err) {
      this.depth--
      try {
        this.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK")
      } catch {}
      throw err
    }
  }

  close(): void {
    this.cache.clear()
    this.raw.close()
  }
}

export function isBunRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.bun
}

/**
 * WAL checkpoint that waits at most busyMs on other connections (default: never; busy -> false,
 * retried by a later call). TRUNCATE succeeds only when every frame was copied and the file emptied.
 */
export function tryCheckpoint(db: Database, mode: "PASSIVE" | "TRUNCATE" = "TRUNCATE", busyMs = 0): boolean {
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}`)
    const r = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get<{ busy: number; log: number; checkpointed: number }>()
    if (!r) return true
    if (Number(r.busy)) return false
    return mode !== "TRUNCATE" || Number(r.log) <= 0
  } catch {
    return false
  } finally {
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    } catch {}
  }
}

/**
 * POSIX only: the database file is created 0600, and the data directory holding
 * memory.db is 0700. A shared or sticky parent (e.g. /tmp) or one owned by another
 * user is never chmod-ed.
 */
function restrictPermissions(path: string) {
  if (process.platform === "win32") return
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    else if (basename(path) === "memory.db") {
      const s = statSync(dir)
      const own = typeof process.getuid !== "function" || s.uid === process.getuid()
      if (own && !(s.mode & 0o1000) && dir !== dirname(dir) && (s.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
    }
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600))
    else if (typeof process.getuid !== "function" || statSync(path).uid === process.getuid()) chmodSync(path, 0o600)
  } catch {}
}

export type OpenOptions = {
  /** false: the file must already exist (never create an empty database in its place). Default true. */
  create?: boolean
}

export async function openDatabase(path: string, opts: OpenOptions = {}): Promise<Database> {
  const create = opts.create ?? true
  const isFile = path !== ":memory:" && !path.startsWith("file:")
  if (isFile && !create && !existsSync(path)) throw new Error(`database file does not exist: ${path}`)
  if (isFile && create) restrictPermissions(path)
  const wrap = (driver: "node" | "bun", db: any) => {
    try {
      return new Wrapped(path, driver, db, (sql) => db.prepare(sql))
    } catch (e) {
      try {
        db.close()
      } catch {}
      throw e
    }
  }
  if (isBunRuntime()) {
    const mod: any = await import("bun:sqlite")
    return wrap("bun", new mod.Database(path, create ? { create: true } : { readwrite: true, create: false }))
  }
  const mod: any = await import("node:sqlite")
  return wrap("node", new mod.DatabaseSync(path))
}
