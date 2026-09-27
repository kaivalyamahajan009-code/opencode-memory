export function age(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms)
  const min = Math.floor(diff / 60_000)
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

export function observedAgo(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return "observed just now"
  return `observed ${age(ms, now)}`
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0"
  if (Math.abs(n) < 1000) return String(Math.round(n))
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0"
  if (n > 0 && n < 0.01) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export function formatDay(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return "Today"
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return "Yesterday"
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function pct(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(0, Math.min(100, (value / max) * 100))
}

export function sourceLabel(start: number, end: number): string {
  return start === end ? `msg ${start}` : `msg ${start}–${end}`
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function scopeLabel(kind: string, domain?: string | null): string {
  if (kind === "workspace") {
    if (domain === "research") return "Research"
    if (domain === "learning") return "Learning"
    return "Workspace"
  }
  return kind.slice(0, 1).toUpperCase() + kind.slice(1)
}
