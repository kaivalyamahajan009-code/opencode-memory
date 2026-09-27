import { readFileSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { Database } from "./sqlite"
import { isInside, isUncPath, realPath } from "./paths"
import { redact } from "./redact"
import { deterministicId, sha256 } from "./util"

export type ArtifactKind = "svg" | "mermaid"

export function artifactKindForPath(path: string): ArtifactKind | undefined {
  const p = path.toLowerCase()
  if (p.endsWith(".svg")) return "svg"
  if (p.endsWith(".mmd") || p.endsWith(".mermaid")) return "mermaid"
  return undefined
}

/** Paths touched by write/edit/multiedit/apply_patch tool calls. */
export function pathsFromToolCall(tool: string, args: any): string[] {
  if (!args || typeof args !== "object") return []
  if (tool === "write" || tool === "edit" || tool === "multiedit") {
    const p = args.filePath ?? args.file_path ?? args.path
    return typeof p === "string" ? [p] : []
  }
  if (tool === "apply_patch" || tool === "patch") {
    const text: string = args.patchText ?? args.patch ?? args.input ?? ""
    const out: string[] = []
    for (const m of String(text).matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) out.push(m[1].trim())
    for (const m of String(text).matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push(m[1].trim())
    for (const m of String(text).matchAll(/^\+\+\+ b\/(.+)$/gm)) out.push(m[1].trim())
    return [...new Set(out)]
  }
  return []
}

export function svgTitle(svg: string): string | undefined {
  const t = svg.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  if (t) return t.trim().slice(0, 200)
  const aria = svg.match(/aria-label="([^"]+)"/i)?.[1]
  return aria?.slice(0, 200)
}

export function mermaidTitle(src: string): string | undefined {
  const t = src.match(/^\s*(?:---[\s\S]*?title:\s*(.+?)\s*\n[\s\S]*?---)/)?.[1]
  if (t) return t.slice(0, 200)
  const c = src.match(/^\s*%%\s*(.+)$/m)?.[1]
  if (c) return c.slice(0, 200)
  return src.trim().split("\n")[0]?.slice(0, 120)
}

export type ArtifactInput = {
  workspace: string
  projectId?: string
  sessionId?: string
  messageId?: string
  path: string
  kind: ArtifactKind
  origin: string
  content: string
  title?: string
  concepts?: string[]
  now?: number
}

const MAX_CONTENT = 200_000

export function upsertArtifact(db: Database, a: ArtifactInput): string {
  const now = a.now ?? Date.now()
  const content = redact(a.content).text
  const hash = sha256(content)
  const id = deterministicId("art", a.path, hash)
  const title = a.title ? redact(a.title).text : a.kind === "svg" ? svgTitle(content) : mermaidTitle(content)
  db.prepare(
    `INSERT INTO artifacts(id, workspace, project_id, session_id, message_id, path, kind, origin, hash, title, concepts, content, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(path, hash) DO UPDATE SET updated_at = excluded.updated_at,
       concepts = COALESCE(excluded.concepts, artifacts.concepts), title = COALESCE(excluded.title, artifacts.title)`,
  ).run(
    id,
    a.workspace,
    a.projectId ?? null,
    a.sessionId ?? null,
    a.messageId ?? null,
    a.path,
    a.kind,
    a.origin,
    hash,
    title ?? null,
    a.concepts?.length ? JSON.stringify(a.concepts) : null,
    content.length <= MAX_CONTENT ? content : null,
    now,
    now,
  )
  return id
}

export { isUncPath }

/**
 * Real path of a tool-written file, only when it is inside the project directory both
 * lexically and after resolving symlinks. UNC paths are rejected before any fs call.
 */
export function resolveArtifactPath(directory: string, raw: string): string | undefined {
  if (!raw || raw.includes("\0") || isUncPath(raw) || isUncPath(directory)) return undefined
  const base = resolve(directory)
  const full = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  if (isUncPath(full) || !isInside(base, full)) return undefined
  try {
    const root = realPath(base)
    const real = realPath(full)
    if (isUncPath(root) || isUncPath(real) || !isInside(root, real)) return undefined
    return real
  } catch {
    return undefined
  }
}

/** Register artifacts written to disk by a tool call (files inside the project directory only). */
export function captureToolArtifacts(
  db: Database,
  input: { tool: string; args: any; directory: string; workspace: string; projectId: string; sessionId: string },
): string[] {
  const ids: string[] = []
  for (const raw of pathsFromToolCall(input.tool, input.args)) {
    const kind = artifactKindForPath(raw)
    if (!kind) continue
    const full = resolveArtifactPath(input.directory, raw)
    if (!full) continue
    const st = statSync(full)
    if (!st.isFile() || st.size > 2_000_000) continue
    const content = readFileSync(full, "utf8")
    ids.push(
      upsertArtifact(db, {
        workspace: input.workspace,
        projectId: input.projectId,
        sessionId: input.sessionId,
        path: full,
        kind,
        origin: `tool:${input.tool}`,
        content,
      }),
    )
  }
  return ids
}

/** SVG and Mermaid produced inline in assistant text (fenced or raw <svg>). */
export function extractInlineArtifacts(text: string): { kind: ArtifactKind; content: string }[] {
  const out: { kind: ArtifactKind; content: string }[] = []
  for (const m of text.matchAll(/```(svg|mermaid|xml)\s*\n([\s\S]*?)```/gi)) {
    const lang = m[1].toLowerCase()
    const body = m[2].trim()
    if (lang === "mermaid") out.push({ kind: "mermaid", content: body })
    else if (/<svg[\s>]/i.test(body)) out.push({ kind: "svg", content: body })
  }
  const stripped = text.replace(/```[\s\S]*?```/g, "")
  for (const m of stripped.matchAll(/<svg[\s\S]*?<\/svg>/gi)) out.push({ kind: "svg", content: m[0] })
  return out
}

export function captureInlineArtifacts(
  db: Database,
  input: { text: string; workspace: string; projectId: string; sessionId: string; messageId: string },
): string[] {
  return extractInlineArtifacts(input.text).map((a, i) =>
    upsertArtifact(db, {
      workspace: input.workspace,
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      path: `session://${input.sessionId}/${input.messageId}#${i}`,
      kind: a.kind,
      origin: "assistant-fence",
      content: a.content,
    }),
  )
}

export function listArtifacts(db: Database, filter: { workspace?: string; projectId?: string; limit?: number }) {
  const where: string[] = []
  const params: string[] = []
  if (filter.workspace) {
    where.push("workspace = ?")
    params.push(filter.workspace)
  }
  if (filter.projectId) {
    where.push("project_id = ?")
    params.push(filter.projectId)
  }
  return db
    .prepare(
      `SELECT id, workspace, project_id, session_id, message_id, path, kind, origin, hash, title, concepts, created_at, updated_at,
         content IS NOT NULL AS has_content
       FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all<any>(...params, filter.limit ?? 200)
}

export function setArtifactConcepts(db: Database, id: string, concepts: string[], title?: string): boolean {
  return (
    db
      .prepare("UPDATE artifacts SET concepts = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ? OR path = ?")
      .run(JSON.stringify(concepts), title ?? null, Date.now(), id, id).changes > 0
  )
}
