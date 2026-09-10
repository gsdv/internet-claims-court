import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const caseStatus = v.union(
  v.literal("filed"),
  v.literal("decomposing"),
  v.literal("researching"),
  v.literal("judging"),
  v.literal("decided"),
  v.literal("failed"),
);

export const verdict = v.union(
  v.literal("supported"),
  v.literal("mostly_supported"),
  v.literal("unresolved"),
  v.literal("misleading"),
  v.literal("unsupported"),
);

export const side = v.union(v.literal("for"), v.literal("against"));

export const eventKind = v.union(
  v.literal("filed"),
  v.literal("decomposed"),
  v.literal("search"),
  v.literal("exhibit"),
  v.literal("exhibit_rejected"),
  v.literal("audit"),
  v.literal("objection"),
  v.literal("ruling"),
  v.literal("verdict"),
  v.literal("appeal"),
  v.literal("error"),
  v.literal("note"),
);

export const objectionKind = v.union(
  v.literal("unsupported_leap"),
  v.literal("scope"),
  v.literal("stale"),
  v.literal("conflict_of_interest"),
  v.literal("secondary"),
  v.literal("duplicate"),
  v.literal("other"),
);

export default defineSchema({
  cases: defineTable({
    claim: v.string(),
    status: caseStatus,
    threadId: v.string(),
    workflowId: v.optional(v.string()),
    // Final synthesized ruling.
    verdict: v.optional(verdict),
    confidence: v.optional(v.number()),
    summary: v.optional(v.string()),
    whatWouldChange: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  subclaims: defineTable({
    caseId: v.id("cases"),
    index: v.number(),
    text: v.string(),
    whyItMatters: v.string(),
    queries: v.array(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("researching"),
      v.literal("judging"),
      v.literal("decided"),
    ),
    verdict: v.optional(verdict),
    confidence: v.optional(v.number()),
  }).index("by_case", ["caseId", "index"]),

  // A fetched page. One row per URL per case; exhibits point at it.
  sources: defineTable({
    caseId: v.id("cases"),
    url: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    markdown: v.string(),
    truncated: v.boolean(),
    fetchedAt: v.number(),
    query: v.optional(v.string()),
  }).index("by_case_url", ["caseId", "url"]),

  exhibits: defineTable({
    caseId: v.id("cases"),
    subclaimId: v.id("subclaims"),
    sourceId: v.id("sources"),
    side,
    url: v.string(),
    title: v.string(),
    quote: v.string(),
    note: v.string(),
    sourceType: v.string(),
    verified: v.boolean(),
    verificationNote: v.string(),
    filedBy: v.string(),
    number: v.number(),
    // Auditor's reliability score for this source on this subclaim (0-100).
    sourceScore: v.optional(v.number()),
    sourceScoreNote: v.optional(v.string()),
    appealId: v.optional(v.id("appeals")),
  })
    .index("by_case", ["caseId", "number"])
    .index("by_subclaim", ["subclaimId"]),

  // Cross-Examiner's objections against exhibits on the record.
  objections: defineTable({
    caseId: v.id("cases"),
    subclaimId: v.id("subclaims"),
    exhibitNumber: v.number(),
    kind: objectionKind,
    text: v.string(),
    severity: v.number(), // 1 minor, 2 material, 3 fatal
    round: v.number(),
    createdAt: v.number(),
  })
    .index("by_subclaim", ["subclaimId", "round"])
    .index("by_case", ["caseId"]),

  // A user challenge to one subclaim's ruling; triggers a partial retrial.
  appeals: defineTable({
    caseId: v.id("cases"),
    subclaimId: v.id("subclaims"),
    argument: v.string(),
    url: v.optional(v.string()),
    status: v.union(v.literal("filed"), v.literal("heard"), v.literal("failed")),
    workflowId: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_case", ["caseId", "createdAt"])
    .index("by_subclaim", ["subclaimId"]),

  // Subclaim rulings (subclaimId set) and case verdicts (subclaimId unset),
  // versioned so revisions are visible.
  rulings: defineTable({
    caseId: v.id("cases"),
    subclaimId: v.optional(v.id("subclaims")),
    appealId: v.optional(v.id("appeals")),
    version: v.number(),
    verdict,
    confidence: v.number(),
    reasoning: v.string(),
    whatWouldChange: v.string(),
    keyExhibits: v.array(v.number()),
    createdAt: v.number(),
  })
    .index("by_case", ["caseId", "createdAt"])
    .index("by_subclaim", ["subclaimId", "version"]),

  // Live docket feed.
  events: defineTable({
    caseId: v.id("cases"),
    kind: eventKind,
    actor: v.string(),
    message: v.string(),
    subclaimId: v.optional(v.id("subclaims")),
    exhibitNumber: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_case", ["caseId", "createdAt"]),
});
