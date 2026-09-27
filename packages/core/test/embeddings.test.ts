import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { createEmbedder } from "../src/embeddings"
import type { EmbeddingConfig } from "../src/config"

describe("OpenAI-compatible embedding headers", () => {
  let server: Server
  let port = 0
  let requestCount = 0
  let capturedHeaders: Record<string, string | string[] | undefined> = {}

  beforeAll(async () => {
    server = createServer((req, res) => {
      requestCount++
      capturedHeaders = req.headers
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [{ index: 0, embedding: [0.25, 0.75] }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    port = address && typeof address === "object" ? address.port : 0
  })

  afterAll(async () => {
    delete process.env.OM_EMBEDDING_TEST_KEY
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function config(headers?: Record<string, string>, apiKeyEnv?: string): EmbeddingConfig {
    return {
      provider: "openai-compatible",
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: "embedding-test",
      batchSize: 4,
      headers,
      apiKeyEnv,
    }
  }

  test("sends custom headers while generated content type and API-key authorization win", async () => {
    process.env.OM_EMBEDDING_TEST_KEY = "embedding-key"
    const embedder = createEmbedder(
      config(
        {
          "X-Tenant": "memory-team",
          "Content-Type": "text/plain",
          Authorization: "Custom secret that must not win",
        },
        "OM_EMBEDDING_TEST_KEY",
      ),
    )
    expect(embedder).toBeDefined()
    const vectors = await embedder!.embed(["remember this"])
    expect(Array.from(vectors[0])).toEqual([0.25, 0.75])
    expect(capturedHeaders["x-tenant"]).toBe("memory-team")
    expect(capturedHeaders["content-type"]).toBe("application/json")
    expect(capturedHeaders.authorization).toBe("Bearer embedding-key")
  })

  test("keeps custom authorization when no embedding API key is available", async () => {
    delete process.env.OM_EMBEDDING_TEST_KEY
    const embedder = createEmbedder(config({ Authorization: "Basic custom-credential" }, "OM_EMBEDDING_TEST_KEY"))
    await embedder!.embed(["remember this too"])
    expect(capturedHeaders.authorization).toBe("Basic custom-credential")
    expect(capturedHeaders["content-type"]).toBe("application/json")
  })

  test("rejects unsafe custom headers before making a request without exposing values", async () => {
    for (const headers of [
      { "Bad Header": "sensitive-name-value" },
      { "x-injected": "safe\r\nx-evil: sensitive-line-value" },
      JSON.parse('{"constructor":"sensitive-prototype-value"}') as Record<string, string>,
    ]) {
      const before = requestCount
      const error = await createEmbedder(config(headers))!
        .embed(["must not be sent"])
        .catch((e: unknown) => e)
      expect(String((error as Error).message)).toBe("embedding headers are invalid")
      expect(String((error as Error).message)).not.toContain("sensitive")
      expect(requestCount).toBe(before)
    }
  })
})
