import { v } from "convex/values";
import { z } from "zod";
import { Output } from "ai";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { internalAction } from "./_generated/server";
import { internal, components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { clerk, researcher, judge } from "./agents";

const firecrawl = new FirecrawlClient(components.firecrawl);

// No thread history in prompts: every call is given exactly the evidence it
// needs, and scraped pages would otherwise balloon the context.
const noContext = { contextOptions: { recentMessages: 0 } } as const;

const verdictEnum = z.enum([
  "supported",
  "mostly_supported",
  "unresolved",
  "misleading",
  "unsupported",
]);

// ---------------------------------------------------------------------------
// Step 1: Clerk decomposes the claim into subclaims.
// ---------------------------------------------------------------------------
export const decompose = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.array(v.id("subclaims")),
  handler: async (ctx, { caseId }): Promise<Id<"subclaims">[]> => {
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    if (!c) throw new Error("case not found");
    await ctx.runMutation(internal.cases.setStatus, { caseId, status: "decomposing" });

    const { output } = await clerk.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Claim under review:\n"""${c.claim}"""\n\nDecompose it into 3 to 5 testable subclaims. For each, give two web search queries (one aimed at primary sources, one at critical or independent coverage) that would surface the best evidence.`,
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
// Step 2: Researcher searches the live web and files exhibits for a subclaim.
// ---------------------------------------------------------------------------
const MAX_SOURCES_PER_SUBCLAIM = 8;
const MAX_CHARS_PER_SOURCE_IN_PROMPT = 6000;
const MAX_STORED_MARKDOWN = 120_000;

type Fetched = {
  url: string;
  title?: string;
  description?: string;
  markdown: string;
  query: string;
};

export const research = internalAction({
  args: { caseId: v.id("cases"), subclaimId: v.id("subclaims") },
  returns: v.null(),
  handler: async (ctx, { caseId, subclaimId }): Promise<null> => {
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    const sub: Doc<"subclaims"> | null = await ctx.runQuery(internal.cases.getSubclaim, { subclaimId });
    if (!c || !sub) throw new Error("case or subclaim not found");
    await ctx.runMutation(internal.cases.setSubclaimStatus, {
      subclaimId,
      status: "researching",
    });

    // --- Discovery via Firecrawl search (web + news), scraping each hit. ---
    const seen = new Map<string, Fetched>();
    for (const query of sub.queries.slice(0, 3)) {
      await ctx.runMutation(internal.cases.logEvent, {
        caseId,
        subclaimId,
        kind: "search",
        actor: "Researcher",
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
          actor: "Researcher",
          message: `Search failed for "${query}": ${(e as Error).message}`,
        });
        continue;
      }
      const hits = [...(res.web ?? []), ...(res.news ?? [])];
      for (const h of hits) {
        const url = (h as any).url ?? (h as any).metadata?.sourceURL;
        const markdown = (h as any).markdown as string | undefined;
        if (!url || !markdown || markdown.trim().length < 200) continue;
        if (seen.has(url)) continue;
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

    const fetched = [...seen.values()];
    if (fetched.length === 0) {
      await ctx.runMutation(internal.cases.logEvent, {
        caseId,
        subclaimId,
        kind: "note",
        actor: "Researcher",
        message: "No usable pages found for this subclaim.",
      });
      await ctx.runMutation(internal.cases.setSubclaimStatus, {
        subclaimId,
        status: "judging",
      });
      return null;
    }

    // --- Persist sources (the record the Auditor will check against). ---
    const sourceIds: Id<"sources">[] = [];
    for (const f of fetched) {
      const id = await ctx.runMutation(internal.cases.upsertSource, {
        caseId,
        url: f.url,
        title: f.title,
        description: f.description,
        markdown: f.markdown.slice(0, MAX_STORED_MARKDOWN),
        truncated: f.markdown.length > MAX_STORED_MARKDOWN,
        query: f.query,
      });
      sourceIds.push(id);
    }
    await ctx.runMutation(internal.cases.logEvent, {
      caseId,
      subclaimId,
      kind: "note",
      actor: "Researcher",
      message: `Retrieved ${fetched.length} pages. Reading for evidence…`,
    });

    // --- Ask the Researcher to file exhibits with verbatim quotes. ---
    const pagesBlock = fetched
      .map(
        (f, i) =>
          `### PAGE ${i + 1}\nURL: ${f.url}\nTITLE: ${f.title ?? "(untitled)"}\n\n${f.markdown.slice(0, MAX_CHARS_PER_SOURCE_IN_PROMPT)}`,
      )
      .join("\n\n");

    const { output } = await researcher.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Overall claim: "${c.claim}"\nSubclaim you are researching: "${sub.text}"\nWhy it matters: ${sub.whyItMatters}\n\nBelow are ${fetched.length} scraped pages. File up to 6 exhibits total. Each exhibit must quote the page VERBATIM (15-60 words, exact characters). Mark side "for" if the quote supports the subclaim and "against" if it undermines it. If a page is irrelevant, skip it.\n\n${pagesBlock}`,
        output: Output.object({
          schema: z.object({
            exhibits: z
              .array(
                z.object({
                  page: z.number().int().min(1),
                  side: z.enum(["for", "against"]),
                  quote: z.string(),
                  note: z.string().describe("One sentence: what this proves or undermines and why"),
                  sourceType: z
                    .string()
                    .describe("e.g. primary announcement, paper, news report, opinion, social post"),
                }),
              )
              .max(6),
          }),
        }),
        ...noContext,
      },
    );

    // --- Audit: verify every quote against the stored page text. ---
    for (const ex of output?.exhibits ?? []) {
      const f = fetched[ex.page - 1];
      const sourceId = sourceIds[ex.page - 1];
      if (!f || !sourceId) continue;
      const check = verifyQuote(ex.quote, f.markdown);
      await ctx.runMutation(internal.cases.insertExhibit, {
        caseId,
        subclaimId,
        sourceId,
        side: ex.side,
        url: f.url,
        title: f.title ?? f.url,
        quote: ex.quote,
        note: ex.note,
        sourceType: ex.sourceType,
        verified: check.ok,
        verificationNote: check.note,
        filedBy: "Researcher",
      });
    }

    await ctx.runMutation(internal.cases.setSubclaimStatus, {
      subclaimId,
      status: "judging",
    });
    return null;
  },
});

// Normalizes typography and whitespace, then requires the quote to appear
// verbatim or, failing that, that nearly all of its 5-word shingles appear.
export function verifyQuote(quote: string, page: string): { ok: boolean; note: string } {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—‒]/g, "-")
      .replace(/ /g, " ")
      .replace(/[*_`#>\[\]()|\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const q = norm(quote);
  const p = norm(page);
  if (q.length < 20) return { ok: false, note: "Quote too short to verify" };
  if (p.includes(q)) return { ok: true, note: "Verbatim match in source" };
  const words = q.split(" ");
  if (words.length < 6) return { ok: false, note: "Quote not found in source" };
  const shingles: string[] = [];
  for (let i = 0; i + 5 <= words.length; i++) shingles.push(words.slice(i, i + 5).join(" "));
  const hit = shingles.filter((s) => p.includes(s)).length;
  const ratio = hit / shingles.length;
  if (ratio >= 0.8)
    return { ok: true, note: `Near-verbatim match (${Math.round(ratio * 100)}% of phrases found)` };
  return {
    ok: false,
    note: `Quote not found in source (${Math.round(ratio * 100)}% of phrases matched)`,
  };
}

// ---------------------------------------------------------------------------
// Step 3: Judge rules on one subclaim from the exhibits on record.
// ---------------------------------------------------------------------------
function exhibitsBlock(exhibits: Doc<"exhibits">[]) {
  if (exhibits.length === 0) return "(no exhibits on record)";
  return exhibits
    .map(
      (e) =>
        `Exhibit ${e.number} [${e.side.toUpperCase()}] ${e.verified ? "VERIFIED" : "UNVERIFIED - " + e.verificationNote}\nSource: ${e.title} <${e.url}> (${e.sourceType})\nQuote: "${e.quote}"\nNote: ${e.note}`,
    )
    .join("\n\n");
}

export const judgeSubclaim = internalAction({
  args: { caseId: v.id("cases"), subclaimId: v.id("subclaims") },
  returns: v.null(),
  handler: async (ctx, { caseId, subclaimId }): Promise<null> => {
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    const sub: Doc<"subclaims"> | null = await ctx.runQuery(internal.cases.getSubclaim, { subclaimId });
    if (!c || !sub) throw new Error("case or subclaim not found");
    const exhibits: Doc<"exhibits">[] = await ctx.runQuery(internal.cases.exhibitsForSubclaim, {
      subclaimId,
    });

    const { output } = await judge.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Overall claim: "${c.claim}"\nSubclaim to rule on: "${sub.text}"\nWhy it matters: ${sub.whyItMatters}\n\nRecord:\n${exhibitsBlock(exhibits)}\n\nRule on the subclaim.`,
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

    await ctx.runMutation(internal.cases.insertRuling, {
      caseId,
      subclaimId,
      ...output,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Step 4: Judge synthesizes the case verdict from subclaim rulings.
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

    const { output } = await judge.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Claim under review: "${c.claim}"\n\nSubclaim rulings:\n${block}\n\nDeliver the verdict on the claim AS A CASUAL READER WOULD UNDERSTAND IT. If the headline claim is technically true but implies something unverified or disputed, say so plainly. Summary should be 3-5 sentences a non-expert can read.`,
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
