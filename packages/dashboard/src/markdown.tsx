import { For, Show } from "solid-js"

type Bullet = { text: string; refs: string[] }
type Block =
  | { t: "h"; level: number; text: string }
  | { t: "quote"; text: string }
  | { t: "ul"; items: Bullet[] }
  | { t: "p"; text: string }

function parseRefs(line: string): Bullet {
  const m = line.match(/^(.*?)\s+[—–-]\s*refs?:\s*(.+)$/i)
  if (!m) return { text: line, refs: [] }
  const refs = m[2]
    .split(/[, ]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return { text: m[1].trim(), refs }
}

export function parseSafeMarkdown(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  let bullets: Bullet[] = []
  const flush = () => {
    if (bullets.length) {
      blocks.push({ t: "ul", items: bullets })
      bullets = []
    }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }
    const hm = line.match(/^(#{1,3})\s+(.*)$/)
    if (hm) {
      flush()
      blocks.push({ t: "h", level: hm[1].length, text: hm[2].trim() })
      continue
    }
    if (line.startsWith(">")) {
      flush()
      blocks.push({ t: "quote", text: line.replace(/^>\s?/, "") })
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      bullets.push(parseRefs(line.replace(/^[-*]\s+/, "")))
      continue
    }
    flush()
    blocks.push({ t: "p", text: line })
  }
  flush()
  return blocks
}

export function SafeMarkdown(props: { source: string; onRef?: (id: string) => void }) {
  const blocks = () => parseSafeMarkdown(props.source || "")
  const heading = (level: number, text: string) => {
    if (level === 1) return <h1 class="mb-2 text-[15px] font-semibold">{text}</h1>
    if (level === 2) return <h2 class="mt-3 mb-1 text-[13px] font-semibold">{text}</h2>
    return <h3 class="mt-2 mb-1 text-[12px] font-medium">{text}</h3>
  }
  return (
    <div class="space-y-1">
      <For each={blocks()}>
        {(b) => (
          <Show
            when={b.t === "h"}
            fallback={
              <Show
                when={b.t === "quote"}
                fallback={
                  <Show
                    when={b.t === "ul"}
                    fallback={
                      <p class="whitespace-pre-wrap">{(b as { t: "p"; text: string }).text}</p>
                    }
                  >
                    <ul class="list-disc space-y-1 pl-4">
                      <For each={(b as { t: "ul"; items: Bullet[] }).items}>
                        {(item) => (
                          <li>
                            <span class="whitespace-pre-wrap">{item.text}</span>
                            <Show when={item.refs.length}>
                              <span class="ml-1 text-neutral-500">
                                <For each={item.refs}>
                                  {(id, i) => (
                                    <>
                                      <Show when={i() > 0}>, </Show>
                                      <button
                                        type="button"
                                        class="underline decoration-dotted"
                                        onClick={() => props.onRef?.(id)}
                                      >
                                        {id}
                                      </button>
                                    </>
                                  )}
                                </For>
                              </span>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                }
              >
                <blockquote class="border-l-2 border-neutral-300 pl-2 text-neutral-600 italic dark:border-neutral-600 dark:text-neutral-300">
                  {(b as { t: "quote"; text: string }).text}
                </blockquote>
              </Show>
            }
          >
            {heading((b as { t: "h"; level: number; text: string }).level, (b as { t: "h"; level: number; text: string }).text)}
          </Show>
        )}
      </For>
    </div>
  )
}
