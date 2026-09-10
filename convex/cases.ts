import { v } from "convex/values";
import { createThread } from "@convex-dev/agent";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import { caseStatus, eventKind, objectionKind, side, verdict } from "./schema";
import { trialWorkflow } from "./trial";
import { quotesOverlap } from "./lib/quotes";

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
      .take(20);
    const exhibits = await ctx.db
      .query("exhibits")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .take(200);
    const rulings = await ctx.db
      .query("rulings")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .take(200);
    const objections = await ctx.db
      .query("objections")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .take(200);
    const appeals = await ctx.db
      .query("appeals")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .take(50);
    const events = await ctx.db
      .query("events")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .order("desc")
      .take(200);
    const { threadId: _t, workflowId: _w, ...publicCase } = c;
    const caseRulings = rulings
      .filter((r) => r.subclaimId === undefined)
      .sort((a, b) => a.version - b.version);
    return {
      case: publicCase,
      verdictHistory: caseRulings.map((r) => ({
        version: r.version,
        verdict: r.verdict,
        confidence: r.confidence,
        createdAt: r.createdAt,
      })),
      subclaims: subclaims.map((s) => {
        const mine = rulings
          .filter((r) => r.subclaimId === s._id)
          .sort((a, b) => b.version - a.version);
        return {
          ...s,
          exhibits: exhibits.filter((e) => e.subclaimId === s._id),
          objections: objections.filter((o) => o.subclaimId === s._id),
          ruling: mine[0],
          priorRulings: mine.slice(1),
          appeals: appeals
            .filter((a) => a.subclaimId === s._id)
            .map(({ workflowId: _wf, ...a }) => a),
        };
      }),
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

export const fileAppeal = mutation({
  args: { subclaimId: v.id("subclaims"), argument: v.string(), url: v.optional(v.string()) },
  returns: v.id("appeals"),
  handler: async (ctx, { subclaimId, argument, url }) => {
    const text = argument.trim();
    if (text.length < 10) throw new Error("Give the court an argument (10+ characters).");
    if (text.length > 1500) throw new Error("Argument is too long (1500 chars max).");
    let cleanUrl: string | undefined;
    if (url && url.trim()) {
      try {
        const u = new URL(url.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
        cleanUrl = u.toString();
      } catch {
        throw new Error("Evidence URL must be a valid http(s) link.");
      }
    }
    const sub = await ctx.db.get(subclaimId);
    if (!sub) throw new Error("Subclaim not found.");
    const c = await ctx.db.get(sub.caseId);
    if (!c) throw new Error("Case not found.");
    if (c.status !== "decided") throw new Error("Wait for the current ruling before appealing.");
    const pending = await ctx.db
      .query("appeals")
      .withIndex("by_case", (q) => q.eq("caseId", c._id))
      .filter((q) => q.eq(q.field("status"), "filed"))
      .first();
    if (pending) throw new Error("An appeal is already being heard on this case.");

    const now = Date.now();
    const appealId = await ctx.db.insert("appeals", {
      caseId: c._id,
      subclaimId,
      argument: text,
      url: cleanUrl,
      status: "filed",
      createdAt: now,
    });
    await ctx.db.patch(c._id, { status: "researching", updatedAt: now });
    await ctx.db.patch(subclaimId, { status: "researching" });
    await ctx.db.insert("events", {
      caseId: c._id,
      subclaimId,
      kind: "appeal",
      actor: "Appellant",
      message: `Appeal filed on subclaim ${sub.index + 1}${cleanUrl ? " with new evidence" : ""}. Retrial ordered.`,
      createdAt: now,
    });
    const workflowId = await trialWorkflow.start(
      ctx,
      internal.trial.appeal,
      { caseId: c._id, subclaimId, appealId },
      { onComplete: internal.trial.onAppealComplete, context: { caseId: c._id, appealId } },
    );
    await ctx.db.patch(appealId, { workflowId });
    return appealId;
  },
});

// ---------------------------------------------------------------------------
// Internal helpers used by the workflow and actions
// ---------------------------------------------------------------------------

export const getSources = internalQuery({
  args: { sourceIds: v.array(v.id("sources")) },
  handler: async (ctx, { sourceIds }) => {
    const docs = await Promise.all(sourceIds.map((id) => ctx.db.get(id)));
    return docs.filter((d): d is NonNullable<typeof d> => d !== null);
  },
});

export const getAppeal = internalQuery({
  args: { appealId: v.id("appeals") },
  handler: (ctx, { appealId }) => ctx.db.get(appealId),
});

export const appealUrl = internalQuery({
  args: { appealId: v.id("appeals") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { appealId }) => (await ctx.db.get(appealId))?.url ?? null,
});

export const setAppealStatus = internalMutation({
  args: {
    appealId: v.id("appeals"),
    status: v.union(v.literal("filed"), v.literal("heard"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { appealId, status, error }) => {
    await ctx.db.patch(appealId, { status, ...(error ? { error } : {}) });
    if (status === "failed") {
      const a = await ctx.db.get(appealId);
      if (a)
        await ctx.db.insert("events", {
          caseId: a.caseId,
          subclaimId: a.subclaimId,
          kind: "error",
          actor: "Court",
          message: `Appeal could not be heard: ${error ?? "unknown error"}`,
          createdAt: Date.now(),
        });
    }
  },
});

export const objectionsForSubclaim = internalQuery({
  args: { subclaimId: v.id("subclaims") },
  handler: (ctx, { subclaimId }) =>
    ctx.db
      .query("objections")
      .withIndex("by_subclaim", (q) => q.eq("subclaimId", subclaimId))
      .take(50),
});

export const latestRuling = internalQuery({
  args: { subclaimId: v.id("subclaims") },
  handler: (ctx, { subclaimId }) =>
    ctx.db
      .query("rulings")
      .withIndex("by_subclaim", (q) => q.eq("subclaimId", subclaimId))
      .order("desc")
      .first(),
});

export const scoreExhibit = internalMutation({
  args: { exhibitId: v.id("exhibits"), sourceScore: v.number(), sourceScoreNote: v.string() },
  handler: async (ctx, { exhibitId, ...rest }) => {
    await ctx.db.patch(exhibitId, rest);
  },
});

// Cross-examination is re-run on retrial; the previous round is replaced.
export const replaceObjections = internalMutation({
  args: {
    caseId: v.id("cases"),
    subclaimId: v.id("subclaims"),
    objections: v.array(
      v.object({
        exhibitNumber: v.number(),
        kind: objectionKind,
        text: v.string(),
        severity: v.number(),
      }),
    ),
  },
  handler: async (ctx, { caseId, subclaimId, objections }) => {
    const old = await ctx.db
      .query("objections")
      .withIndex("by_subclaim", (q) => q.eq("subclaimId", subclaimId))
      .take(50);
    const round = (old[old.length - 1]?.round ?? 0) + 1;
    for (const o of old) await ctx.db.delete(o._id);
    const now = Date.now();
    for (const o of objections) {
      await ctx.db.insert("objections", { caseId, subclaimId, round, createdAt: now, ...o });
      await ctx.db.insert("events", {
        caseId,
        subclaimId,
        exhibitNumber: o.exhibitNumber,
        kind: "objection",
        actor: "Cross-Examiner",
        message: `Objection to Ex. ${o.exhibitNumber} (${o.kind.replace(/_/g, " ")}, severity ${o.severity}): ${o.text}`,
        createdAt: now,
      });
    }
    if (objections.length === 0) {
      const sub = await ctx.db.get(subclaimId);
      await ctx.db.insert("events", {
        caseId,
        subclaimId,
        kind: "note",
        actor: "Cross-Examiner",
        message: `No objections to the record on subclaim ${(sub?.index ?? 0) + 1}.`,
        createdAt: now,
      });
    }
  },
});

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
      .take(50),
});

export const subclaimsWithRulings = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const subs = await ctx.db
      .query("subclaims")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .take(20);
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
    appealId: v.optional(v.id("appeals")),
  },
  handler: async (ctx, args) => {
    const last = await ctx.db
      .query("exhibits")
      .withIndex("by_case", (q) => q.eq("caseId", args.caseId))
      .order("desc")
      .first();
    const number = (last?.number ?? 0) + 1;
    // The Clerk refuses a quote already on the record for this subclaim, so
    // counsel cannot pad their side by refiling the other side's evidence.
    let { verified, verificationNote } = args;
    if (verified) {
      const existing = await ctx.db
        .query("exhibits")
        .withIndex("by_subclaim", (q) => q.eq("subclaimId", args.subclaimId))
        .take(50);
      const dup = existing.find((e) => e.verified && quotesOverlap(e.quote, args.quote));
      if (dup) {
        verified = false;
        verificationNote = `Duplicate of Exhibit ${dup.number} (${dup.side === args.side ? "same side" : "filed by " + dup.filedBy})`;
      }
    }
    await ctx.db.insert("exhibits", { ...args, verified, verificationNote, number });
    const host = safeHost(args.url);
    await ctx.db.insert("events", {
      caseId: args.caseId,
      subclaimId: args.subclaimId,
      exhibitNumber: number,
      kind: verified ? "exhibit" : "exhibit_rejected",
      actor: verified ? args.filedBy : verificationNote.startsWith("Duplicate") ? "Clerk" : "Auditor",
      message: verified
        ? `Exhibit ${number} filed ${args.side === "for" ? "FOR" : "AGAINST"} from ${host}`
        : `Exhibit ${number} (${args.filedBy}, ${host}) rejected: ${verificationNote}`,
      createdAt: Date.now(),
    });
  },
});

export const insertRuling = internalMutation({
  args: {
    caseId: v.id("cases"),
    subclaimId: v.id("subclaims"),
    appealId: v.optional(v.id("appeals")),
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
      message:
        prev && prev.verdict !== args.verdict
          ? `On appeal, subclaim ${(sub?.index ?? 0) + 1} REVISED from ${label(prev.verdict)} to ${label(args.verdict)} at ${Math.round(args.confidence)}% confidence`
          : prev
            ? `On appeal, subclaim ${(sub?.index ?? 0) + 1} AFFIRMED ${label(args.verdict)} at ${Math.round(args.confidence)}% confidence`
            : `Subclaim ${(sub?.index ?? 0) + 1} ruled ${label(args.verdict)} at ${Math.round(args.confidence)}% confidence`,
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
    const c = await ctx.db.get(caseId);
    const prevVerdict = c?.verdict;
    const prevRuling = await ctx.db
      .query("rulings")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .filter((q) => q.eq(q.field("subclaimId"), undefined))
      .order("desc")
      .first();
    const now = Date.now();
    await ctx.db.insert("rulings", {
      caseId,
      version: (prevRuling?.version ?? 0) + 1,
      verdict: args.verdict,
      confidence: args.confidence,
      reasoning: args.summary,
      whatWouldChange: args.whatWouldChange,
      keyExhibits: [],
      createdAt: now,
    });
    await ctx.db.patch(caseId, { ...rest, status: "decided", updatedAt: now });
    for (const s of await ctx.db
      .query("subclaims")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .take(20)) {
      if (s.status !== "decided") await ctx.db.patch(s._id, { status: "decided" });
    }
    await ctx.db.insert("events", {
      caseId,
      kind: "verdict",
      actor: "Judge",
      message: prevVerdict
        ? prevVerdict !== args.verdict
          ? `Verdict REVISED from ${label(prevVerdict)} to ${label(args.verdict)} at ${Math.round(args.confidence)}% confidence`
          : `Verdict AFFIRMED: ${label(args.verdict)} at ${Math.round(args.confidence)}% confidence`
        : `Verdict: ${label(args.verdict)} at ${Math.round(args.confidence)}% confidence`,
      createdAt: now,
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
