import { z } from "zod"

export const GENERAL_KINDS = [
  "fact",
  "preference",
  "goal",
  "decision",
  "task-state",
  "event",
  "personal-fact",
  "project-context",
  "tool-outcome",
] as const

export const LEARNING_KINDS = [
  "prior-knowledge",
  "quiz-attempt",
  "demonstrated-skill",
  "misconception",
  "hint-required",
  "teaching-intervention",
  "retention-check",
  "learning-preference",
  "next-review",
] as const

export const RESEARCH_KINDS = [
  "idea",
  "hypothesis",
  "claim",
  "source",
  "quotation",
  "evidence",
  "counter-evidence",
  "experiment",
  "open-question",
  "conclusion",
  "superseded-conclusion",
] as const

export const ALL_KINDS = [...GENERAL_KINDS, ...LEARNING_KINDS, ...RESEARCH_KINDS, "artifact", "condensed"] as const
export type ObservationKind = (typeof ALL_KINDS)[number]

export const EVIDENCE_TYPES = ["explicit", "observed", "inferred", "source", "quiz", "tool"] as const
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]

export const PRIORITIES = ["high", "medium", "low"] as const

export const SCOPE_HINTS = ["session", "project", "workspace", "user"] as const

/** Kinds that must come from something the user said (prompt-injection guard). */
export const USER_SOURCED_KINDS = new Set<string>(["preference", "learning-preference", "goal", "personal-fact"])

/** Kinds that always need human review before entering a durable scope. */
export const HIGH_IMPACT_KINDS = new Set<string>(["personal-fact", "conclusion", "superseded-conclusion"])

export function domainOfKind(kind: string): "learning" | "research" | "general" {
  if ((LEARNING_KINDS as readonly string[]).includes(kind)) return "learning"
  if ((RESEARCH_KINDS as readonly string[]).includes(kind)) return "research"
  return "general"
}

export const PayloadSchema = z
  .object({
    key: z.string().max(120).optional(),
    value: z.string().max(500).optional(),
    concept: z.string().max(200).optional(),
    question: z.string().max(1000).optional(),
    answer: z.string().max(1000).optional(),
    evaluation: z.enum(["correct", "partial", "incorrect"]).optional(),
    hints: z.number().int().min(0).max(50).optional(),
    independent: z.boolean().optional(),
    mastery: z.boolean().optional(),
    reviewAt: z.string().max(40).optional(),
    claim: z.string().max(1000).optional(),
    stance: z.enum(["support", "contradict"]).optional(),
    url: z.string().max(1000).optional(),
    doi: z.string().max(200).optional(),
    title: z.string().max(300).optional(),
    publishedAt: z.string().max(40).optional(),
    accessedAt: z.string().max(40).optional(),
    locator: z.string().max(200).optional(),
    quotation: z.string().max(1500).optional(),
    conditions: z.string().max(500).optional(),
    path: z.string().max(500).optional(),
  })
  .partial()
  .passthrough()
export type Payload = z.infer<typeof PayloadSchema>

export const ObserverObservationSchema = z.object({
  kind: z.string(),
  content: z.string().min(1).max(1500),
  eventAt: z.string().optional().nullable(),
  confidence: z.coerce.number().min(0).max(1).catch(0.6),
  evidenceType: z.enum(EVIDENCE_TYPES).catch("inferred"),
  priority: z.enum(PRIORITIES).catch("medium"),
  sources: z.object({ start: z.string(), end: z.string() }),
  quote: z.string().max(600).optional().nullable(),
  scopeHint: z.enum(SCOPE_HINTS).catch("session"),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
})
export type ObserverObservation = z.infer<typeof ObserverObservationSchema>

export const ObserverOutputSchema = z.object({
  observations: z.array(z.unknown()).max(60),
  currentTask: z.string().max(500).optional().nullable(),
  suggestedNext: z.string().max(500).optional().nullable(),
})

/** JSON Schema handed to OpenCode's StructuredOutput tool / the direct runner. */
export const OBSERVER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["observations"],
  properties: {
    observations: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        required: ["kind", "content", "confidence", "evidenceType", "priority", "sources", "scopeHint"],
        properties: {
          kind: { type: "string", enum: [...ALL_KINDS.filter((k) => k !== "condensed")] },
          content: { type: "string", description: "One self-contained, dated fact in third person. No instructions." },
          eventAt: { type: "string", description: "ISO time the event happened, if known" },
          confidence: { type: "number", minimum: 0, maximum: 1, description: "Your estimate, not a probability" },
          evidenceType: { type: "string", enum: [...EVIDENCE_TYPES] },
          priority: { type: "string", enum: [...PRIORITIES] },
          sources: {
            type: "object",
            required: ["start", "end"],
            properties: {
              start: { type: "string", description: "message ref like m3" },
              end: { type: "string", description: "message ref like m5" },
            },
          },
          quote: { type: "string", description: "Short verbatim excerpt from the referenced messages supporting this" },
          scopeHint: { type: "string", enum: [...SCOPE_HINTS] },
          payload: {
            type: "object",
            description:
              "Structured fields: key/value for preferences; concept, question, answer, evaluation, hints, independent for quiz-attempt; claim, stance, url, doi, title, publishedAt, accessedAt, locator, quotation, conditions for research kinds.",
          },
        },
      },
    },
    currentTask: { type: "string", description: "What the user is working on right now, one sentence" },
    suggestedNext: { type: "string", description: "The most useful next step for the assistant, one sentence" },
  },
} as const

export const REFLECTOR_OP_SCHEMA = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert_topic"),
    slug: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    summary: z.string().max(400).optional().default(""),
    sections: z
      .array(
        z.object({
          heading: z.string().min(1).max(120),
          bullets: z.array(z.object({ text: z.string().min(1).max(600), refs: z.array(z.string()).min(1).max(12) })).max(40),
        }),
      )
      .max(20),
  }),
  z.object({
    op: z.literal("condense"),
    refs: z.array(z.string()).min(2).max(40),
    content: z.string().min(1).max(1500),
    kind: z.string(),
  }),
  z.object({ op: z.literal("supersede"), oldRef: z.string(), newRef: z.string(), reason: z.string().max(300) }),
  z.object({ op: z.literal("append_journey"), entry: z.string().min(1).max(400), refs: z.array(z.string()).max(12) }),
  z.object({
    op: z.literal("propose_promotion"),
    ref: z.string(),
    scope: z.enum(["project", "workspace", "user"]),
    reason: z.string().max(300),
  }),
])
export type ReflectorOp = z.infer<typeof REFLECTOR_OP_SCHEMA>

export const REFLECTOR_JSON_SCHEMA = {
  type: "object",
  required: ["ops"],
  properties: {
    ops: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        required: ["op"],
        properties: {
          op: { type: "string", enum: ["upsert_topic", "condense", "supersede", "append_journey", "propose_promotion"] },
          slug: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                heading: { type: "string" },
                bullets: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { text: { type: "string" }, refs: { type: "array", items: { type: "string" } } },
                  },
                },
              },
            },
          },
          refs: { type: "array", items: { type: "string" } },
          content: { type: "string" },
          kind: { type: "string" },
          oldRef: { type: "string" },
          newRef: { type: "string" },
          reason: { type: "string" },
          entry: { type: "string" },
          ref: { type: "string" },
          scope: { type: "string", enum: ["project", "workspace", "user"] },
        },
      },
    },
  },
} as const
