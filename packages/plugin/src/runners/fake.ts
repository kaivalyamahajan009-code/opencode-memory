import { RunnerError, type ModelRunner, type RunRequest, type RunResult } from "@opencode-memory/core"

export type FakeOutput = unknown | ((req: RunRequest, signal: AbortSignal) => unknown | Promise<unknown>)

const EMPTY = { observations: [] }

export class FakeRunner implements ModelRunner {
  readonly id = "fake"
  private index = 0

  constructor(private readonly outputs: FakeOutput[] = []) {}

  async run(req: RunRequest, signal: AbortSignal): Promise<RunResult> {
    if (signal.aborted) throw new RunnerError("aborted", "aborted")
    const list = this.outputs
    const raw = !list.length ? EMPTY : list[Math.min(this.index, list.length - 1)]
    if (this.index < list.length) this.index++
    const value = typeof raw === "function" ? await raw(req, signal) : raw
    if (value instanceof Error) throw value
    return { output: value, inputTokens: 12, outputTokens: 24, cost: 0, model: "fake" }
  }
}
