export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string }

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export function unwrapEnvelope<T>(json: unknown, httpStatus: number): { ok: true; data: T } | { ok: false; error: string; status: number } {
  if (!json || typeof json !== "object") return { ok: false, error: httpStatus ? `HTTP ${httpStatus}` : "Empty response", status: httpStatus || 400 }
  const j = json as ApiEnvelope<T>
  if (j.ok === false) return { ok: false, error: j.error || "Request failed", status: httpStatus || 400 }
  if (j.ok === true) {
    const nested = unwrapNestedFailure(j.data)
    if (!nested.ok) return { ok: false, error: nested.error, status: nested.status }
    return { ok: true, data: j.data }
  }
  return { ok: false, error: "unexpected response", status: httpStatus || 400 }
}

export function unwrapNestedFailure(data: unknown): { ok: true } | { ok: false; error: string; status: number } {
  if (!data || typeof data !== "object") return { ok: true }
  const d = data as Record<string, unknown>
  if (d.ok === false) return { ok: false, error: String(d.error ?? "failed"), status: 400 }
  if ("done" in d && d.done === false) return { ok: false, error: "not found or already resolved", status: 409 }
  return { ok: true }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Status 0 means the server could not be reached at all. */
export async function requestJson<T>(fetchImpl: FetchLike, path: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("x-om-token", token)
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  let res: Response
  try {
    res = await fetchImpl(path, { ...init, headers })
  } catch {
    throw new ApiError("Memory API unreachable", 0)
  }
  if (res.status === 401) throw new ApiError("Unauthorized", 401)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status)
    throw new ApiError("Invalid response from memory API", res.status)
  }
  const parsed = unwrapEnvelope<T>(json, res.status)
  if (!parsed.ok) throw new ApiError(parsed.error, parsed.status)
  return parsed.data
}
