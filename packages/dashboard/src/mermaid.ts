export type MermaidApi = {
  initialize: (opts: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}

let pending: Promise<MermaidApi> | undefined

const mermaidOpts = (): Record<string, unknown> => ({
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  theme: document.documentElement.classList.contains("dark") ? "dark" : "neutral",
})

export function loadMermaid(): Promise<MermaidApi> {
  pending ??= import("mermaid")
    .then((mod) => {
      const mermaid = (mod.default ?? mod) as MermaidApi
      mermaid.initialize(mermaidOpts())
      return mermaid
    })
    .catch((e) => {
      pending = undefined
      throw e
    })
  return pending
}

export async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid()
  mermaid.initialize(mermaidOpts())
  const id = `om-${Math.random().toString(36).slice(2, 10)}`
  const { svg } = await mermaid.render(id, source)
  return svg
}
