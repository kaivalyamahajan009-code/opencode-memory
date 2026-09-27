import { afterAll, describe, expect, test } from "bun:test"
import { cleanupAllTempDirs, openHarness, seed } from "./helpers"
import { redact } from "../src/redact"
import { snapshotParts } from "../src/normalize"
import { upsertArtifact } from "../src/artifacts"
import { putObservation } from "./helpers"

afterAll(cleanupAllTempDirs)

const SECRETS = {
  openai: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
  anthropic: "sk-ant-abcdefghijklmnopqrstuvwxyz123456",
  github: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  aws: "AKIAIOSFODNN7EXAMPLE",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3fakekeymaterialhere\n-----END RSA PRIVATE KEY-----",
  bearer: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijklmnopqrst",
  url: "https://alice:s3cretpass@github.com/org/repo.git",
  password: "password=supersecretvalue",
}

function blob() {
  return [
    `openai ${SECRETS.openai}`,
    `anthropic ${SECRETS.anthropic}`,
    `github ${SECRETS.github}`,
    `aws ${SECRETS.aws}`,
    SECRETS.privateKey,
    SECRETS.bearer,
    `clone ${SECRETS.url}`,
    `export ${SECRETS.password}`,
  ].join("\n")
}

describe("redaction", () => {
  test("redact() strips OpenAI, Anthropic, GitHub, AWS, private keys, bearer, URL credentials, and password assignments", () => {
    const r = redact(blob())
    expect(r.count).toBeGreaterThanOrEqual(8)
    expect(r.text).not.toContain(SECRETS.openai)
    expect(r.text).not.toContain(SECRETS.anthropic)
    expect(r.text).not.toContain(SECRETS.github)
    expect(r.text).not.toContain(SECRETS.aws)
    expect(r.text).not.toContain("BEGIN RSA PRIVATE KEY")
    expect(r.text).not.toMatch(/Bearer\s+eyJ/)
    expect(r.text).not.toContain("alice:s3cretpass")
    expect(r.text).not.toContain("supersecretvalue")
    expect(r.text).toContain("[REDACTED:openai-key]")
    expect(r.text).toContain("[REDACTED:anthropic-key]")
    expect(r.text).toContain("[REDACTED:github-token]")
    expect(r.text).toContain("[REDACTED:aws-access-key]")
    expect(r.text).toContain("[REDACTED:private-key]")
    expect(r.text).toContain("[REDACTED:bearer]")
    expect(r.text).toContain("[REDACTED:url-credentials]")
    expect(r.text).toContain("[REDACTED:assignment]")
  })

  test("snapshots redact secrets in captured parts", () => {
    const parts = snapshotParts(
      [
        { id: "p1", type: "text", text: `here is a key ${SECRETS.openai}` },
        { id: "p2", type: "tool", tool: "bash", state: { status: "completed", output: `export ${SECRETS.password}\n${SECRETS.github}`, input: {} } },
      ],
      { captureReasoning: false, toolOutputMax: 4000 },
    )
    expect(parts[0].text).not.toContain(SECRETS.openai)
    expect(parts[0].redactions).toBeGreaterThan(0)
    expect(parts[1].text).not.toContain("supersecretvalue")
    expect(parts[1].text).not.toContain(SECRETS.github)
  })

  test("observations store redacted content when the observer text is redacted first", async () => {
    const h = await openHarness()
    try {
      const { workspace, projectId } = seed(h.db)
      const content = redact(`User pasted ${SECRETS.anthropic} into chat`).text
      expect(content).not.toContain(SECRETS.anthropic)
      putObservation(h.db, { workspace, projectId, content, sessionId: "ses_a" })
      const row = h.db.prepare("SELECT content FROM observations").get<{ content: string }>()
      expect(row?.content).toContain("[REDACTED:anthropic-key]")
      expect(row?.content).not.toContain("sk-ant-")
    } finally {
      h.close()
    }
  })

  test("artifacts redact secrets in stored content", async () => {
    const h = await openHarness()
    try {
      seed(h.db)
      const svg = `<svg><title>token ${SECRETS.github}</title></svg>`
      const id = upsertArtifact(h.db, {
        workspace: "learn",
        projectId: "proj_a",
        sessionId: "ses_a",
        path: "/tmp/diagram.svg",
        kind: "svg",
        origin: "test",
        content: svg,
      })
      const row = h.db.prepare("SELECT content, title FROM artifacts WHERE id = ?").get<{ content: string; title: string }>(id)
      expect(row?.content).not.toContain(SECRETS.github)
      expect(row?.title).not.toContain(SECRETS.github)
    } finally {
      h.close()
    }
  })
})
