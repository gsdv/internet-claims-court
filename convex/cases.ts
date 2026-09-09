import { v } from "convex/values";
import { createThread } from "@convex-dev/agent";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import { caseStatus, eventKind, side, verdict } from "./schema";
import { trialWorkflow } from "./trial";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const fileClaim = mutation({
  args: { claim: v.string() },
  returns: v.id("cases"),
  handler: async (ctx, { claim }) => {
    const text = claim.trim();
    if (text.length < 8) throw new Error("Claim is too short.");
    if (text.length > 600) throw new Error("Claim is too long (600 chars max).");
    const now = Date.now();
    const threadId = await createThread(ctx, components.agent, {
      title: text.slice(0, 80),
    });
    const caseId = await ctx.db.insert("cases", {
      claim: text,
      status: "filed",
      threadId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("events", {
      caseId,
      kind: "filed",
      actor: "Court",
      message: "Case filed. Assigning the Clerk.",
      createdAt: now,
    });
    const workflowId = await trialWorkflow.start(
      ctx,
      internal.trial.trial,
      { caseId },
      { onComplete: internal.trial.onTrialComplete, context: { caseId } },
    );
    await ctx.db.patch(caseId, { workflowId });
    return caseId;
  },
});

export const listCases = query({
  args: {},
  handler: async (ctx) => {
    const cases = await ctx.db.query("cases").withIndex("by_createdAt").order("desc").take(30);
    return cases.map((c) => ({
      _id: c._id,
      claim: c.claim,
      status: c.status,
      verdict: c.verdict,
      confidence: c.confidence,
      createdAt: c.createdAt,
    }));
  },
});

// Everything the docket page needs, in one reactive subscription.
export const getDocket = query({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const c = await ctx.db.get(caseId);
    if (!c) return null;
    const subclaims = await ctx.db
      .query("subclaims")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    const exhibits = await ctx.db
      .query("exhibits")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    const rulings = await ctx.db
      .query("rulings")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    const events = await ctx.db
      .query("events")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .order("desc")
      .take(200);
    const { threadId: _t, workflowId: _w, ...publicCase } = c;
    return {
      case: publicCase,
      subclaims: subclaims.map((s) => ({
        ...s,
        exhibits: exhibits.filter((e) => e.subclaimId === s._id),
        ruling: rulings
          .filter((r) => r.subclaimId === s._id)
          .sort((a, b) => b.version - a.version)[0],
      })),
      events,
      stats: {
        for: exhibits.filter((e) => e.side === "for" && e.verified).length,
        against: exhibits.filter((e) => e.side === "against" && e.verified).length,
        rejected: exhibits.filter((e) => !e.verified).length,
        sources: new Set(exhibits.map((e) => e.url)).size,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Internal helpers used by the workflow and actions
// ---------------------------------------------------------------------------

export const getInternal = internalQuery({
  args: { caseId: v.id("cases") },
  handler: (ctx, { caseId }) => ctx.db.get(caseId),
});

export const getSubclaim = internalQuery({
  args: { subclaimId: v.id("subclaims") },
  handler: (ctx, { subclaimId }) => ctx.db.get(subclaimId),
});

export const exhibitsForSubclaim = internalQuery({
  args: { subclaimId: v.id("subclaims") },
  handler: (ctx, { subclaimId }) =>
    ctx.db
      .query("exhibits")
      .withIndex("by_subclaim", (q) => q.eq("subclaimId", subclaimId))
      .collect(),
});

export const subclaimsWithRulings = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const subs = await ctx.db
      .query("subclaims")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    return Promise.all(
      subs.map(async (s) => {
        const ruling = await ctx.db
          .query("rulings")
          .withIndex("by_subclaim", (q) => q.eq("subclaimId", s._id))
          .order("desc")
          .first();
        return { ...s, ruling };
      }),
    );
  },
});

export const setStatus = internalMutation({
  args: { caseId: v.id("cases"), status: caseStatus, error: v.optional(v.string()) },
  handler: async (ctx, { caseId, status, error }) => {
    await ctx.db.patch(caseId, { status, updatedAt: Date.now(), ...(error ? { error } : {}) });
    if (status === "failed") {
      await ctx.db.insert("events", {
        caseId,
        kind: "error",
        actor: "Court",
        message: `Mistrial: ${error ?? "unknown error"}`,
        createdAt: Date.now(),
      });
    }
  },
});

export const setSubclaimStatus = internalMutation({
  args: {
    subclaimId: v.id("subclaims"),
    status: v.union(
      v.literal("pending"),
      v.literal("researching"),
      v.literal("judging"),
      v.literal("decided"),
    ),
  },
  handler: async (ctx, { subclaimId, status }) => {
    await ctx.db.patch(subclaimId, { status });
  },
});

export const logEvent = internalMutation({
  args: {
    caseId: v.id("cases"),
    kind: eventKind,
    actor: v.string(),
    message: v.string(),
    subclaimId: v.optional(v.id("subclaims")),
    exhibitNumber: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("events", { ...args, createdAt: Date.now() });
  },
});

export const insertSubclaims = internalMutation({
  args: {
    caseId: v.id("cases"),
    subclaims: v.array(
      v.object({ text: v.string(), whyItMatters: v.string(), queries: v.array(v.string()) }),
    ),
  },
  returns: v.array(v.id("subclaims")),
  handler: async (ctx, { caseId, subclaims }) => {
    const ids = [];
    for (let i = 0; i < subclaims.length; i++) {
      ids.push(
        await ctx.db.insert("subclaims", { caseId, index: i, ...subclaims[i], status: "pending" }),
      );
    }
    await ctx.db.insert("events", {
      caseId,
      kind: "decomposed",
      actor: "Clerk",
      message: `Docketed ${subclaims.length} subclaims for trial.`,
      createdAt: Date.now(),
    });
    return ids;
  },
});

export const upsertSource = internalMutation({
  args: {
    caseId: v.id("cases"),
    url: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    markdown: v.string(),
    truncated: v.boolean(),
    query: v.optional(v.string()),
  },
  returns: v.id("sources"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sources")
      .withIndex("by_case_url", (q) => q.eq("caseId", args.caseId).eq("url", args.url))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("sources", { ...args, fetchedAt: Date.now() });
  },
});

export const insertExhibit = internalMutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const last = await ctx.db
      .query("exhibits")
      .withIndex("by_case", (q) => q.eq("caseId", args.caseId))
      .order("desc")
      .first();
    const number = (last?.number ?? 0) + 1;
    await ctx.db.insert("exhibits", { ...args, number });
    const host = safeHost(args.url);
    await ctx.db.insert("events", {
      caseId: args.caseId,
      subclaimId: args.subclaimId,
      exhibitNumber: number,
      kind: args.verified ? "exhibit" : "exhibit_rejected",
      actor: args.verified ? args.filedBy : "Auditor",
      message: args.verified
        ? `Exhibit ${number} filed ${args.side === "for" ? "FOR" : "AGAINST"} from ${host}`
        : `Exhibit ${number} from ${host} rejected: ${args.verificationNote}`,
      createdAt: Date.now(),
    });
  },
});

export const insertRuling = internalMutation({
  args: {
    caseId: v.id("cases"),
    subclaimId: v.id("subclaims"),
    verdict,
    confidence: v.number(),
    reasoning: v.string(),
    whatWouldChange: v.string(),
    keyExhibits: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    const prev = await ctx.db
      .query("rulings")
      .withIndex("by_subclaim", (q) => q.eq("subclaimId", args.subclaimId))
      .order("desc")
      .first();
    const version = (prev?.version ?? 0) + 1;
    await ctx.db.insert("rulings", { ...args, version, createdAt: Date.now() });
    await ctx.db.patch(args.subclaimId, {
      status: "decided",
      verdict: args.verdict,
      confidence: args.confidence,
    });
    const sub = await ctx.db.get(args.subclaimId);
    await ctx.db.insert("events", {
      caseId: args.caseId,
      subclaimId: args.subclaimId,
      kind: "ruling",
      actor: "Judge",
      message: `Subclaim ${(sub?.index ?? 0) + 1} ruled ${label(args.verdict)} at ${Math.round(args.confidence)}% confidence`,
      createdAt: Date.now(),
    });
  },
});

export const decide = internalMutation({
  args: {
    caseId: v.id("cases"),
    verdict,
    confidence: v.number(),
    summary: v.string(),
    whatWouldChange: v.string(),
  },
  handler: async (ctx, args) => {
    const { caseId, ...rest } = args;
    await ctx.db.patch(caseId, { ...rest, status: "decided", updatedAt: Date.now() });
    await ctx.db.insert("events", {
      caseId,
      kind: "verdict",
      actor: "Judge",
      message: `Verdict: ${label(args.verdict)} at ${Math.round(args.confidence)}% confidence`,
      createdAt: Date.now(),
    });
  },
});

function label(v: string) {
  return v.replace("_", " ").toUpperCase();
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
