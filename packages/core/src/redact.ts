export type RedactionRule = {
  name: string
  pattern: RegExp
  /** Receives the full match plus groups; returns the replacement. */
  replace?: (match: string, ...groups: string[]) => string
}

const marker = (name: string) => `[REDACTED:${name}]`

export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe-key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    name: "bearer",
    pattern: /\b(bearer|token)\s+([A-Za-z0-9._~+/-]{20,}=*)/gi,
    replace: (_m, kw) => `${kw} ${marker("bearer")}`,
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi,
    replace: (_m, scheme) => `${scheme}${marker("url-credentials")}@`,
  },
  {
    name: "assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|pwd|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)(\s*["']?\s*[:=]\s*["']?)([^\s"'`,;]{6,})/gi,
    replace: (_m, key, sep) => `${key}${sep}${marker("assignment")}`,
  },
]

function entropy(s: string): number {
  const freq = new Map<string, number>()
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

const CANDIDATE = /[A-Za-z0-9+/=_-]{32,}/g

function looksLikeSecret(token: string): boolean {
  if (/^[0-9a-f]+$/i.test(token) && token.length <= 64) return false
  if (/^[a-z_-]+$/i.test(token)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(token)).length
  if (classes < 3) return false
  return entropy(token) >= 4.2
}

export type RedactionResult = { text: string; count: number; rules: string[] }

export function redact(input: string, rules: RedactionRule[] = DEFAULT_RULES): RedactionResult {
  let text = input
  let count = 0
  const hit = new Set<string>()
  for (const rule of rules) {
    text = text.replace(rule.pattern, (...args) => {
      count++
      hit.add(rule.name)
      const match = args[0] as string
      const groups = args.slice(1, -2) as string[]
      return rule.replace ? rule.replace(match, ...groups) : marker(rule.name)
    })
  }
  text = text.replace(CANDIDATE, (token) => {
    if (token.includes("REDACTED")) return token
    if (!looksLikeSecret(token)) return token
    count++
    hit.add("high-entropy")
    return marker("high-entropy")
  })
  return { text, count, rules: [...hit] }
}
