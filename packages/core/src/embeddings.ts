import type { Database } from "./sqlite"
import { openAICompatibleHeaders, type EmbeddingConfig } from "./config"
import { isSuppressed, suppressionTargetForRow } from "./observations"

export interface Embedder {
  readonly model: string
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}

export function createEmbedder(cfg: EmbeddingConfig): Embedder | undefined {
  if (cfg.provider !== "openai-compatible" || !cfg.baseURL || !cfg.model) return undefined
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined
  const url = `${cfg.baseURL.replace(/\/$/, "")}/embeddings`
  return {
    model: cfg.model,
    async embed(texts, signal) {
      let headers: Headers
      try {
        headers = openAICompatibleHeaders(cfg.headers, key)
      } catch {
        throw new Error("embedding headers are invalid")
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.model, input: texts }),
        signal,
      })
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = (await res.json()) as { data: { embedding: number[]; index: number }[] }
      return json.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding))
    },
  }
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
}

function fromBlob(b: Uint8Array | ArrayBuffer): Float32Array {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  const copy = new Uint8Array(u.byteLength)
  copy.set(u)
  return new Float32Array(copy.buffer)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

export function storeEmbedding(db: Database, contentHash: string, model: string, v: Float32Array, now = Date.now()) {
  db.prepare("INSERT OR REPLACE INTO embeddings(content_hash, model, dim, vector, created_at) VALUES (?,?,?,?,?)").run(
    contentHash,
    model,
    v.length,
    toBlob(v),
    now,
  )
}

export function loadEmbeddings(db: Database, model: string, hashes: string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  for (let i = 0; i < hashes.length; i += 400) {
    const batch = hashes.slice(i, i + 400)
    const rows = db
      .prepare(`SELECT content_hash, vector FROM embeddings WHERE model = ? AND content_hash IN (${batch.map(() => "?").join(",")})`)
      .all<{ content_hash: string; vector: Uint8Array }>(model, ...batch)
    for (const r of rows) out.set(r.content_hash, fromBlob(r.vector))
  }
  return out
}

/** Content of a live row with this hash that no suppression covers where that row lives (scoped suppressions act only in their boundary). */
function embeddableContent(db: Database, hash: string): string | undefined {
  const rows = db
    .prepare(
      "SELECT content, scope_kind, project_id, workspace, status, target_scope FROM observations WHERE content_hash = ? AND status IN ('active','pending_review')",
    )
    .all<{ content: string; scope_kind: string; project_id: string | null; workspace: string; status: string; target_scope: string | null }>(hash)
  return rows.find((r) => !isSuppressed(db, r.content, suppressionTargetForRow(r)))?.content
}

/** Embed active observations that do not yet have a vector for this model. Suppressed content is never sent to the embedder. */
export async function backfillEmbeddings(db: Database, embedder: Embedder, opts: { batchSize: number; max?: number; signal?: AbortSignal }) {
  const rows = db
    .prepare(
      `SELECT DISTINCT o.content_hash FROM observations o
       LEFT JOIN embeddings e ON e.content_hash = o.content_hash AND e.model = ?
       WHERE e.content_hash IS NULL AND o.status IN ('active','pending_review') LIMIT ?`,
    )
    .all<{ content_hash: string }>(embedder.model, opts.max ?? 256)
    .flatMap((r) => {
      const content = embeddableContent(db, r.content_hash)
      return content === undefined ? [] : [{ content_hash: r.content_hash, content }]
    })
  let done = 0
  for (let i = 0; i < rows.length; i += opts.batchSize) {
    const batch = rows.slice(i, i + opts.batchSize)
    const vectors = await embedder.embed(
      batch.map((r) => r.content),
      opts.signal,
    )
    db.tx(() =>
      batch.forEach((r, j) => {
        if (!vectors[j]) return
        if (embeddableContent(db, r.content_hash) === undefined) return
        storeEmbedding(db, r.content_hash, embedder.model, vectors[j])
      }),
    )
    done += batch.length
  }
  return done
}

/** Remove vectors whose content no longer exists anywhere (after forget, restore and backup scrub; incl. edited-away hashes). */
export function pruneOrphanEmbeddings(db: Database): number {
  return db
    .prepare(
      `DELETE FROM embeddings WHERE NOT EXISTS (
         SELECT 1 FROM observations o WHERE o.content_hash = embeddings.content_hash AND o.status != 'forgotten'
       )`,
    )
    .run().changes
}
