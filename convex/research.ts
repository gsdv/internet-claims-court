import { v } from "convex/values";
import { z } from "zod";
import { Output } from "ai";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { internalAction } from "./_generated/server";
import { internal, components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { auditor, clerk, crossExaminer, defender, judge, prosecutor } from "./agents";
import { verifyQuote } from "./lib/quotes";

const firecrawl = new FirecrawlClient(components.firecrawl);

// No thread history in prompts: every call is given exactly the evidence it
// needs, and scraped pages would otherwise balloon the context.
const noContext = {
  contextOptions: { recentMessages: 0, searchOptions: { limit: 0 } },
} as const;
// Advocate prompts embed whole scraped pages; keep them out of the thread.
const noContextNoSave = { ...noContext, storageOptions: { saveMessages: "none" } } as const;

const verdictEnum = z.enum([
  "supported",
  "mostly_supported",
  "unresolved",
  "misleading",
  "unsupported",
]);

const MAX_SOURCES_PER_SUBCLAIM = 8;
const MAX_CHARS_PER_SOURCE_IN_PROMPT = 7000;
const MAX_STORED_MARKDOWN = 80_000;
const MIN_USEFUL_CHARS = 1500;
const SKIP_HOSTS = [
  "youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "linkedin.com",
];

// ---------------------------------------------------------------------------
// Step 1: Clerk decomposes the claim into subclaims.
// ---------------------------------------------------------------------------
export const decompose = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.array(v.id("subclaims")),
  handler: async (ctx, { caseId }): Promise<Id<"subclaims">[]> => {
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    if (!c) throw new Error("case not found");
    // A retrial after a mistrial keeps the Clerk's original docket.
    const existing: Array<Doc<"subclaims"> & { ruling: Doc<"rulings"> | null }> =
      await ctx.runQuery(internal.cases.subclaimsWithRulings, { caseId });
    if (existing.length > 0) {
      await ctx.runMutation(internal.cases.setStatus, { caseId, status: "researching" });
      return existing.map((s) => s._id);
    }
    await ctx.runMutation(internal.cases.setStatus, { caseId, status: "decomposing" });

    const { output } = await clerk.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Claim under review:\n"""${c.claim}"""\n\nDecompose it into 3 to 5 affirmative, testable subclaims. For each, give two web search queries (one aimed at primary sources, one at critical or independent coverage) that would surface the best evidence.`,
        output: Output.object({
          schema: z.object({
            subclaims: z
              .array(
                z.object({
                  text: z.string(),
                  whyItMatters: z.string(),
                  queries: z.array(z.string()).min(1).max(3),
                }),
              )
              .min(3)
              .max(5),
          }),
        }),
        ...noContext,
      },
    );
    if (!output) throw new Error("Clerk returned no output");

    const ids: Id<"subclaims">[] = await ctx.runMutation(internal.cases.insertSubclaims, {
      caseId,
      subclaims: output.subclaims,
    });
    await ctx.runMutation(internal.cases.setStatus, { caseId, status: "researching" });
    return ids;
  },
});

// ---------------------------------------------------------------------------
// Step 2: Gather pages for a subclaim via Firecrawl search (web + news).
// ---------------------------------------------------------------------------
type Fetched = {
  url: string;
  title?: string;
  description?: string;
  markdown: string;
  query: string;
};

function usable(url: string, markdown: string | undefined): markdown is string {
  if (!markdown) return false;
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
  if (SKIP_HOSTS.some((h) => host === h || host.endsWith("." + h))) return false;
  // Strip link/image noise before measuring how much prose is really there.
  const prose = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return prose.length >= MIN_USEFUL_CHARS;
}

export const gather = internalAction({
  args: { caseId: v.id("cases"), subclaimId: v.id("subclaims") },
  returns: v.array(v.id("sources")),
  handler: async (ctx, { caseId, subclaimId }): Promise<Id<"sources">[]> => {
    const sub: Doc<"subclaims"> | null = await ctx.runQuery(internal.cases.getSubclaim, {
      subclaimId,
    });
    if (!sub) throw new Error("subclaim not found");
    await ctx.runMutation(internal.cases.setSubclaimStatus, { subclaimId, status: "researching" });

    const seen = new Map<string, Fetched>();
    let skipped = 0;
    for (const query of sub.queries.slice(0, 3)) {
      await ctx.runMutation(internal.cases.logEvent, {
        caseId,
        subclaimId,
        kind: "search",
        actor: "Clerk",
        message: `Searching the web: "${query}"`,
      });
      let res;
      try {
        res = await firecrawl.search(ctx, query, {
          limit: 4,
          sources: ["web", "news"],
          scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
        });
      } catch (e) {
        await ctx.runMutation(internal.cases.logEvent, {
          caseId,
          subclaimId,
          kind: "error",
          actor: "Clerk",
          message: `Search failed for "${query}": ${(e as Error).message}`,
        });
        continue;
      }
      const hits = [...(res.web ?? []), ...(res.news ?? [])];
      for (const h of hits) {
        const url = (h as any).url ?? (h as any).metadata?.sourceURL;
        const markdown = (h as any).markdown as string | undefined;
        if (!url || seen.has(url)) continue;
        if (!usable(url, markdown)) {
          skipped++;
          continue;
        }
        seen.set(url, {
          url,
          title: (h as any).title ?? (h as any).metadata?.title,
          description: (h as any).description ?? (h as any).metadata?.description,
          markdown,
          query,
        });
        if (seen.size >= MAX_SOURCES_PER_SUBCLAIM) break;
      }
      if (seen.size >= MAX_SOURCES_PER_SUBCLAIM) break;
    }

    const sourceIds: Id<"sources">[] = [];
    for (const f of seen.values()) {
      sourceIds.push(
        await ctx.runMutation(internal.cases.upsertSource, {
          caseId,
          url: f.url,
          title: f.title,
          description: f.description,
          markdown: f.markdown.slice(0, MAX_STORED_MARKDOWN),
          truncated: f.markdown.length > MAX_STORED_MARKDOWN,
          query: f.query,
        }),
      );
    }
    await ctx.runMutation(internal.cases.logEvent, {
      caseId,
      subclaimId,
      kind: "note",
      actor: "Clerk",
      message:
        sourceIds.length === 0
          ? "No usable pages found for this subclaim."
          : `Entered ${sourceIds.length} pages into the record${skipped ? ` (${skipped} thin or unusable pages discarded)` : ""}. Counsel are reading.`,
    });
    return sourceIds;
  },
});

// Fetch one user-supplied URL on appeal.
export const scrapeUrl = internalAction({
  args: { caseId: v.id("cases"), subclaimId: v.id("subclaims"), url: v.string() },
  returns: v.union(v.id("sources"), v.null()),
  handler: async (ctx, { caseId, subclaimId, url }): Promise<Id<"sources"> | null> => {
    await ctx.runMutation(internal.cases.logEvent, {
      caseId,
      subclaimId,
      kind: "search",
      actor: "Clerk",
      message: `Fetching appellant's evidence: ${url}`,
    });
    try {
      const doc = await firecrawl.scrape(ctx, url, { formats: ["markdown"], onlyMainContent: true });
      const markdown = doc.markdown ?? "";
      if (markdown.trim().length < 200) throw new Error("page had no readable text");
      return await ctx.runMutation(internal.cases.upsertSource, {
        caseId,
        url,
        title: doc.metadata?.title,
        description: doc.metadata?.description,
        markdown: markdown.slice(0, MAX_STORED_MARKDOWN),
        truncated: markdown.length > MAX_STORED_MARKDOWN,
        query: "appeal",
      });
    } catch (e) {
      await ctx.runMutation(internal.cases.logEvent, {
        caseId,
        subclaimId,
        kind: "error",
        actor: "Clerk",
        message: `Could not fetch appellant's URL: ${(e as Error).message}`,
      });
      return null;
    }
  },
});

// ---------------------------------------------------------------------------
// Step 3: Prosecution and Defense each file exhibits from the same pages.
// ---------------------------------------------------------------------------
export const argue = internalAction({
  args: {
    caseId: v.id("cases"),
    subclaimId: v.id("subclaims"),
    sourceIds: v.array(v.id("sources")),
    side: v.union(v.literal("for"), v.literal("against")),
    appealId: v.optional(v.id("appeals")),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, subclaimId, sourceIds, side, appealId }): Promise<null> => {
    if (sourceIds.length === 0) return null;
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    const sub: Doc<"subclaims"> | null = await ctx.runQuery(internal.cases.getSubclaim, {
      subclaimId,
    });
    if (!c || !sub) throw new Error("case or subclaim not found");
    const sources: Doc<"sources">[] = await ctx.runQuery(internal.cases.getSources, { sourceIds });
    const appeal: Doc<"appeals"> | null = appealId
      ? await ctx.runQuery(internal.cases.getAppeal, { appealId })
      : null;

    const agent = side === "for" ? prosecutor : defender;
    const actor = side === "for" ? "Prosecution" : "Defense";

    const pagesBlock = sources
      .map(
        (f, i) =>
          `### PAGE ${i + 1}\nURL: ${f.url}\nTITLE: ${f.title ?? "(untitled)"}\n\n${f.markdown.slice(0, MAX_CHARS_PER_SOURCE_IN_PROMPT)}`,
      )
      .join("\n\n");

    const appealBlock = appeal
      ? `\n\nAn appellant has challenged the current ruling with this argument:\n"""${appeal.argument}"""\nConsider it, but file only what the pages actually say.`
      : "";

    const { output } = await agent.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Overall claim: "${c.claim}"\nSubclaim at issue: "${sub.text}"\nWhy it matters: ${sub.whyItMatters}${appealBlock}\n\nBelow are ${sources.length} pages on the record. File up to 4 exhibits ${side === "for" ? "SUPPORTING" : "UNDERMINING"} the subclaim. Each must quote a page VERBATIM (15-60 words, exact characters). Skip irrelevant pages.\n\n${pagesBlock}`,
        output: Output.object({
          schema: z.object({
            exhibits: z
              .array(
                z.object({
                  page: z.number().int().min(1),
                  quote: z.string(),
                  note: z
                    .string()
                    .describe("One sentence: what this establishes or undermines and why"),
                  sourceType: z
                    .string()
                    .describe("e.g. primary announcement, paper, news report, opinion, aggregator"),
                }),
              )
              .max(4),
          }),
        }),
        ...noContextNoSave,
      },
    );

    for (const ex of output?.exhibits ?? []) {
      const src = sources[ex.page - 1];
      if (!src) continue;
      const check = verifyQuote(ex.quote, src.markdown);
      await ctx.runMutation(internal.cases.insertExhibit, {
        caseId,
        subclaimId,
        sourceId: src._id,
        side,
        url: src.url,
        title: src.title ?? src.url,
        quote: ex.quote,
        note: ex.note,
        sourceType: ex.sourceType,
        verified: check.ok,
        verificationNote: check.note,
        filedBy: actor,
        appealId,
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Step 4: Auditor scores the reliability of every verified exhibit's source.
// ---------------------------------------------------------------------------
export const audit = internalAction({
  args: { caseId: v.id("cases"), subclaimId: v.id("subclaims") },
  returns: v.null(),
  handler: async (ctx, { caseId, subclaimId }): Promise<null> => {
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    const sub: Doc<"subclaims"> | null = await ctx.runQuery(internal.cases.getSubclaim, {
      subclaimId,
    });
    if (!c || !sub) throw new Error("case or subclaim not found");
    const exhibits: Doc<"exhibits">[] = await ctx.runQuery(internal.cases.exhibitsForSubclaim, {
      subclaimId,
    });
    const pending = exhibits.filter((e) => e.verified && e.sourceScore === undefined);
    if (pending.length === 0) return null;

    const list = pending
      .map(
        (e) =>
          `Exhibit ${e.number} [${e.side.toUpperCase()}] ${e.title} <${e.url}> (${e.sourceType})\nQuote: "${e.quote}"\nFiled as: ${e.note}`,
      )
      .join("\n\n");

    const { output } = await auditor.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Subclaim: "${sub.text}"\n\nScore the source of each exhibit for reliability on this subclaim.\n\n${list}`,
        output: Output.object({
          schema: z.object({
            scores: z.array(
              z.object({
                exhibit: z.number().int(),
                score: z.number().min(0).max(100),
                note: z.string(),
              }),
            ),
          }),
        }),
        ...noContext,
      },
    );
    const byNumber = new Map(pending.map((e) => [e.number, e]));
    for (const s of output?.scores ?? []) {
      const e = byNumber.get(s.exhibit);
      if (!e) continue;
      await ctx.runMutation(internal.cases.scoreExhibit, {
        exhibitId: e._id,
        sourceScore: s.score,
        sourceScoreNote: s.note,
      });
    }
    const scored = (output?.scores ?? []).filter((s) => byNumber.has(s.exhibit));
    if (scored.length > 0) {
      const avg = Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length);
      const low = scored.filter((s) => s.score < 40).map((s) => s.exhibit);
      await ctx.runMutation(internal.cases.logEvent, {
        caseId,
        subclaimId,
        kind: "audit",
        actor: "Auditor",
        message: `Scored ${scored.length} sources for subclaim ${sub.index + 1} (avg ${avg}/100)${low.length ? `; flagged Ex. ${low.join(", ")} as weak` : ""}`,
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Step 5: Cross-Examiner files objections against exhibits on both sides.
// ---------------------------------------------------------------------------
function exhibitsBlock(exhibits: Doc<"exhibits">[]) {
  if (exhibits.length === 0) return "(no exhibits on record)";
  return exhibits
    .map(
      (e) =>
        `Exhibit ${e.number} [${e.side.toUpperCase()}] ${e.verified ? "VERIFIED" : "UNVERIFIED - " + e.verificationNote}${e.sourceScore !== undefined ? ` | source score ${Math.round(e.sourceScore)}/100: ${e.sourceScoreNote ?? ""}` : ""}\nSource: ${e.title} <${e.url}> (${e.sourceType}), filed by ${e.filedBy}\nQuote: "${e.quote}"\nNote: ${e.note}`,
    )
    .join("\n\n");
}

export const crossExamine = internalAction({
  args: { caseId: v.id("cases"), subclaimId: v.id("subclaims") },
  returns: v.null(),
  handler: async (ctx, { caseId, subclaimId }): Promise<null> => {
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    const sub: Doc<"subclaims"> | null = await ctx.runQuery(internal.cases.getSubclaim, {
      subclaimId,
    });
    if (!c || !sub) throw new Error("case or subclaim not found");
    const exhibits: Doc<"exhibits">[] = await ctx.runQuery(internal.cases.exhibitsForSubclaim, {
      subclaimId,
    });
    const verified = exhibits.filter((e) => e.verified);
    if (verified.length === 0) return null;

    const { output } = await crossExaminer.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Overall claim: "${c.claim}"\nSubclaim at issue: "${sub.text}"\n\nRecord:\n${exhibitsBlock(verified)}\n\nFile your objections.`,
        output: Output.object({
          schema: z.object({
            objections: z
              .array(
                z.object({
                  exhibit: z.number().int(),
                  kind: z.enum([
                    "unsupported_leap",
                    "scope",
                    "stale",
                    "conflict_of_interest",
                    "secondary",
                    "duplicate",
                    "other",
                  ]),
                  text: z.string().describe("One or two sentences"),
                  severity: z.number().int().min(1).max(3),
                }),
              )
              .max(5),
          }),
        }),
        ...noContext,
      },
    );
    const valid = new Set(verified.map((e) => e.number));
    await ctx.runMutation(internal.cases.replaceObjections, {
      caseId,
      subclaimId,
      objections: (output?.objections ?? [])
        .filter((o) => valid.has(o.exhibit))
        .map((o) => ({ exhibitNumber: o.exhibit, kind: o.kind, text: o.text, severity: o.severity })),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Step 6: Judge rules on one subclaim from the exhibits and objections.
// ---------------------------------------------------------------------------
export const judgeSubclaim = internalAction({
  args: {
    caseId: v.id("cases"),
    subclaimId: v.id("subclaims"),
    appealId: v.optional(v.id("appeals")),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, subclaimId, appealId }): Promise<null> => {
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    const sub: Doc<"subclaims"> | null = await ctx.runQuery(internal.cases.getSubclaim, {
      subclaimId,
    });
    if (!c || !sub) throw new Error("case or subclaim not found");
    await ctx.runMutation(internal.cases.setSubclaimStatus, { subclaimId, status: "judging" });
    const exhibits: Doc<"exhibits">[] = await ctx.runQuery(internal.cases.exhibitsForSubclaim, {
      subclaimId,
    });
    const objections: Doc<"objections">[] = await ctx.runQuery(
      internal.cases.objectionsForSubclaim,
      { subclaimId },
    );
    const prior: Doc<"rulings"> | null = await ctx.runQuery(internal.cases.latestRuling, {
      subclaimId,
    });
    const appeal: Doc<"appeals"> | null = appealId
      ? await ctx.runQuery(internal.cases.getAppeal, { appealId })
      : null;

    const objBlock =
      objections.length === 0
        ? "(no objections)"
        : objections
            .map(
              (o) =>
                `Objection to Exhibit ${o.exhibitNumber} [${o.kind}, severity ${o.severity}]: ${o.text}`,
            )
            .join("\n");
    const appealBlock =
      appeal && prior
        ? `\n\nThis is a RETRIAL on appeal. Prior ruling: ${prior.verdict} (${Math.round(prior.confidence)}%): ${prior.reasoning}\nAppellant's argument: """${appeal.argument}"""\nRule afresh on the full record; you may affirm or revise. Address the appellant's argument explicitly.`
        : "";

    const { output } = await judge.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Overall claim: "${c.claim}"\nSubclaim to rule on: "${sub.text}"\nWhy it matters: ${sub.whyItMatters}\n\nRecord:\n${exhibitsBlock(exhibits)}\n\nObjections:\n${objBlock}${appealBlock}\n\nRule on the subclaim.`,
        output: Output.object({
          schema: z.object({
            verdict: verdictEnum,
            confidence: z.number().min(0).max(100),
            reasoning: z.string().describe("3-6 sentences citing exhibit numbers"),
            whatWouldChange: z.string(),
            keyExhibits: z.array(z.number().int()),
          }),
        }),
        ...noContext,
      },
    );
    if (!output) throw new Error("Judge returned no output");

    await ctx.runMutation(internal.cases.insertRuling, { caseId, subclaimId, appealId, ...output });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Step 7: Judge synthesizes the case verdict from subclaim rulings.
// ---------------------------------------------------------------------------
export const synthesize = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { caseId }): Promise<null> => {
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    if (!c) throw new Error("case not found");
    await ctx.runMutation(internal.cases.setStatus, { caseId, status: "judging" });
    const subs: Array<Doc<"subclaims"> & { ruling: Doc<"rulings"> | null }> = await ctx.runQuery(
      internal.cases.subclaimsWithRulings,
      { caseId },
    );

    const block = subs
      .map(
        (s) =>
          `Subclaim ${s.index + 1}: "${s.text}"\nRuling: ${s.ruling?.verdict ?? "none"} (${s.ruling?.confidence ?? "?"}%)\nReasoning: ${s.ruling?.reasoning ?? "no ruling"}`,
      )
      .join("\n\n");
    const priorBlock = c.verdict
      ? `\n\nPrior verdict on this case: ${c.verdict} (${Math.round(c.confidence ?? 0)}%). Revise only if the subclaim rulings warrant it.`
      : "";

    const { output } = await judge.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Claim under review: "${c.claim}"\n\nSubclaim rulings:\n${block}${priorBlock}\n\nDeliver the verdict on the claim AS A CASUAL READER WOULD UNDERSTAND IT. If the headline claim is technically true but implies something unverified or disputed, say so plainly. Summary should be 3-5 sentences a non-expert can read.`,
        output: Output.object({
          schema: z.object({
            verdict: verdictEnum,
            confidence: z.number().min(0).max(100),
            summary: z.string(),
            whatWouldChange: z.string(),
          }),
        }),
        ...noContext,
      },
    );
    if (!output) throw new Error("Judge returned no output");

    await ctx.runMutation(internal.cases.decide, { caseId, ...output });
    return null;
  },
});
