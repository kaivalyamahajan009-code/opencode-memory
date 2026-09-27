import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadConfig,
  openAICompatibleHeaders,
  parseConfigPatch,
  saveConfigPatch,
  stripSensitiveConfigPatch,
} from "../src/config"
import { MemoryError } from "../src/util"

describe("custom provider header config", () => {
  test("accepts and preserves valid direct and embedding headers while treating them as sensitive", () => {
    const directHeaders = { "x-tenant": "memory", "x-endpoint-token": "direct-secret" }
    const embeddingHeaders = { authorization: "Basic embedding-secret", "x-region": "local" }
    const patch = parseConfigPatch({
      runner: { direct: { headers: directHeaders } },
      embeddings: { headers: embeddingHeaders },
    })
    expect(patch.runner?.direct?.headers).toEqual(directHeaders)
    expect(patch.embeddings?.headers).toEqual(embeddingHeaders)
    expect(stripSensitiveConfigPatch(patch)).toEqual({
      runner: { direct: {} },
      embeddings: {},
    })

    const dir = mkdtempSync(join(tmpdir(), "om-config-headers-"))
    const path = join(dir, "config.json")
    const raw = {
      runner: {
        kind: "direct",
        timeoutMs: 180_000,
        direct: {
          baseURL: "https://models.example.invalid/v1",
          model: "observer",
          apiKeyEnv: "OM_MODEL_KEY",
          headers: directHeaders,
        },
      },
      embeddings: {
        provider: "openai-compatible",
        baseURL: "https://embeddings.example.invalid/v1",
        model: "embedding",
        apiKeyEnv: "OM_EMBEDDING_KEY",
        headers: embeddingHeaders,
        batchSize: 8,
      },
    }
    try {
      writeFileSync(path, JSON.stringify(raw))
      expect(loadConfig(path).runner.direct?.headers).toEqual(directHeaders)
      expect(loadConfig(path).embeddings.headers).toEqual(embeddingHeaders)
      saveConfigPatch({ observe: { minFlushTokens: 7 } }, path)
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject(raw)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects invalid names, prototype-reaching keys, and line breaks without echoing sensitive input", () => {
    const cases = [
      { runner: { direct: { headers: { "X-Secret Bad": "private-name-value" } } } },
      { embeddings: { headers: { "x-line": "private\r\nInjected: still-private" } } },
      JSON.parse('{"runner":{"direct":{"headers":{"constructor":"private-constructor"}}}}'),
      JSON.parse('{"embeddings":{"headers":{"__proto__":"private-prototype"}}}'),
    ]
    for (const value of cases) {
      let error: unknown
      try {
        parseConfigPatch(value)
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(MemoryError)
      expect(error).toMatchObject({ code: "invalid", status: 400 })
      expect(String((error as Error).message)).not.toMatch(/X-Secret Bad|private|constructor|__proto__/)
    }
  })

  test("rejects a line-broken generated credential without including it in the error", () => {
    let error: unknown
    try {
      openAICompatibleHeaders({}, "private\r\nInjected: still-private")
    } catch (e) {
      error = e
    }
    expect(String((error as Error).message)).toBe("authorization credential contains a forbidden line break")
    expect(String((error as Error).message)).not.toContain("private")
  })
})
