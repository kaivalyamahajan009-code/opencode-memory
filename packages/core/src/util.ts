import { createHash, randomBytes } from "node:crypto"

export type MemoryErrorCode = "forgotten" | "not_found" | "conflict" | "invalid" | "forbidden"

/** User-facing failure with an HTTP-style status; anything else thrown by core is unexpected (500). */
export class MemoryError extends Error {
  constructor(
    message: string,
    readonly code: MemoryErrorCode,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message)
    this.name = "MemoryError"
  }
}

/** Content that reads like an instruction to the assistant (prompt-injection guard). */
export const INSTRUCTION_PATTERN =
  /\b(ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|messages)|disregard (all |any )?(previous |prior )?instructions|(you|the assistant) (must|should|shall) (always|never)|system prompt|from now on,? (you|the assistant)|always respond with|new instructions?:)/i

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export function shortHash(input: string, length = 16): string {
  return sha256(input).slice(0, length)
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`
}

export function deterministicId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}_${shortHash(parts.join("\u0000"), 20)}`
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function contentHash(text: string): string {
  return sha256(normalizeForHash(text))
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have i in is it its of on or that the this to was were will with you your we our they them he she not no do does did can could should would into about than then so if what which who how when where".split(
    " ",
  ),
)

export function words(text: string): string[] {
  return normalizeForHash(text)
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

export function shingles(text: string, size = 3): string[] {
  const w = words(text)
  if (w.length < size) return w.length ? [w.join(" ")] : []
  const out: string[] = []
  for (let i = 0; i + size <= w.length; i++) out.push(w.slice(i, i + size).join(" "))
  return out
}

/** Hashed shingles let suppression compare near-duplicates without retaining forgotten text. */
export function hashedShingles(text: string): string[] {
  return [...new Set(shingles(text).map((s) => shortHash(s, 12)))]
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 && sb.size === 0) return 1
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  return inter / (sa.size + sb.size - inter)
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function relativeAge(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms)
  const min = Math.floor(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 60) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 24) return `${mo}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

export function startOfUtcDay(now = Date.now()): number {
  return now - (((now % 86_400_000) + 86_400_000) % 86_400_000)
}

export function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function slugify(text: string, max = 60): string {
  const s = normalizeForHash(text).replace(/\s+/g, "-").slice(0, max).replace(/-+$/g, "")
  return s || "untitled"
}

export function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function truncateMiddle(text: string, max: number, headRatio = 0.6): { text: string; omitted: number } {
  if (text.length <= max) return { text, omitted: 0 }
  const head = Math.floor(max * headRatio)
  const tail = max - head
  const omitted = text.length - head - tail
  return {
    text: `${text.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - tail)}`,
    omitted,
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(t)
      resolve()
    })
  })
}

export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.()
      resolve(TIMEOUT)
    }, ms)
    t.unref?.()
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export const TIMEOUT = Symbol("timeout")
