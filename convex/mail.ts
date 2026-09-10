import { v } from "convex/values";
import { z } from "zod";
import { Output } from "ai";
import { AgentMail } from "@agentmail/convex";
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { clerk } from "./agents";
import { openAppeal, openCase } from "./cases";

// The court's inbox. Inbound mail arrives through the Svix-verified webhook in
// http.ts and is dispatched to onMessageReceived below.
export const agentmail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.mail.onMessageReceived,
});

// ---------------------------------------------------------------------------
// Settings (inbox id / address for this deployment)
// ---------------------------------------------------------------------------
async function readSetting(ctx: QueryCtx | MutationCtx, key: string) {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return row?.value ?? null;
}

export const getSetting = internalQuery({
  args: { key: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { key }) => readSetting(ctx, key),
});

export const setSetting = internalMutation({
  args: { key: v.string(), value: v.string() },
  handler: async (ctx, { key, value }) => {
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("settings", { key, value });
  },
});

// Public: the address people can email a claim to.
export const inboxAddress = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: (ctx) => readSetting(ctx, "inboxAddress"),
});

// One-time setup per deployment: create the court inbox and register the
// inbound webhook. Returns the webhook signing secret so the operator can
// store it as AGENTMAIL_WEBHOOK_SECRET (pipe it; do not print it).
export const setup = internalAction({
  args: { username: v.optional(v.string()) },
  returns: v.object({ inbox: v.string(), webhookUrl: v.string(), secret: v.string() }),
  handler: async (
    ctx,
    { username },
  ): Promise<{ inbox: string; webhookUrl: string; secret: string }> => {
    let inboxId: string | null = await ctx.runQuery(internal.mail.getSetting, { key: "inboxId" });
    if (!inboxId) {
      // The component's createInbox is registered internal in 0.1.0 and is
      // not callable from the app, so hit the REST API directly.
      const res = await fetch("https://api.agentmail.to/v0/inboxes", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AGENTMAIL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: username ?? "claims-court",
          display_name: "Internet Claims Court",
        }),
      });
      let inbox: { inbox_id?: string } = {};
      if (res.ok) {
        inbox = (await res.json()) as { inbox_id?: string };
      } else if (res.status === 403) {
        // Key cannot create inboxes (plan or scope): adopt an existing one.
        const list = await fetch("https://api.agentmail.to/v0/inboxes?limit=5", {
          headers: { Authorization: `Bearer ${env.AGENTMAIL_API_KEY}` },
        });
        if (!list.ok) throw new Error(`inbox list failed: ${list.status} ${await list.text()}`);
        const data = (await list.json()) as { inboxes?: Array<{ inbox_id?: string }> };
        inbox = data.inboxes?.[0] ?? {};
        if (!inbox.inbox_id)
          throw new Error(
            "This API key cannot create inboxes and the organization has none. Create an inbox in the AgentMail dashboard, then rerun setup.",
          );
      } else {
        throw new Error(`inbox creation failed: ${res.status} ${await res.text()}`);
      }
      if (!inbox.inbox_id) throw new Error("inbox response had no inbox_id");
      inboxId = inbox.inbox_id;
      await ctx.runMutation(internal.mail.setSetting, { key: "inboxId", value: inboxId });
      await ctx.runMutation(internal.mail.setSetting, { key: "inboxAddress", value: inboxId });
    }
    const webhookUrl = `${env.CONVEX_SITE_URL}/api/agentmail/webhook`;
    const res = await fetch("https://api.agentmail.to/v0/webhooks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AGENTMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
      // No inbox_ids: inbox-scoped keys reject them and already imply the inbox.
      body: JSON.stringify({ url: webhookUrl, event_types: ["message.received"] }),
    });
    if (!res.ok) throw new Error(`webhook registration failed: ${res.status} ${await res.text()}`);
    const wh = (await res.json()) as { secret?: string };
    if (!wh.secret) throw new Error("webhook response had no secret");
    return { inbox: inboxId, webhookUrl, secret: wh.secret };
  },
});

// ---------------------------------------------------------------------------
// Inbound mail: subpoena replies and file-by-email
// ---------------------------------------------------------------------------
type InboundMessage = {
  inbox_id?: string;
  message_id?: string;
  thread_id?: string;
  subject?: string;
  text?: string;
  extracted_text?: string;
  from?: string;
  from_?: string;
  labels?: string[];
};

function cleanSubject(s: string | undefined) {
  return (s ?? "")
    .replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function caseUrl(caseId: Id<"cases">) {
  return `${env.CONVEX_SITE_URL}/case/${caseId}`;
}

export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  handler: async (ctx, { message }) => {
    const m = (message ?? {}) as InboundMessage;
    const inboxId = m.inbox_id;
    if (!inboxId || !m.message_id || !m.thread_id) return;
    const from = m.from ?? m.from_ ?? "";
    if (from.toLowerCase().includes(inboxId.toLowerCase())) return; // our own mail
    const text = (m.extracted_text ?? m.text ?? "").trim();

    // 1. A reply to a subpoena the court issued?
    let inquiry = await ctx.db
      .query("inquiries")
      .withIndex("by_thread", (q) => q.eq("threadId", m.thread_id))
      .first();
    if (!inquiry) {
      // Sent inquiries learn their thread id lazily from delivery status.
      const sent = await ctx.db
        .query("inquiries")
        .filter((q) => q.eq(q.field("status"), "sent"))
        .take(50);
      for (const inq of sent) {
        if (!inq.outboundId || inq.threadId) continue;
        const st = await agentmail.status(ctx, inq.outboundId as any);
        if (st?.threadId) await ctx.db.patch(inq._id, { threadId: st.threadId });
        if (st?.threadId === m.thread_id) inquiry = { ...inq, threadId: st.threadId };
      }
    }
    if (inquiry) {
      await handleSubpoenaReply(ctx, inquiry, m, text, from);
      return;
    }

    // 2. A follow-up on a case that was filed by email: note it, don't refile.
    const existing = await ctx.db
      .query("cases")
      .withIndex("by_filingThread", (q) => q.eq("filingThreadId", m.thread_id))
      .first();
    if (existing) {
      await ctx.db.insert("events", {
        caseId: existing._id,
        kind: "mail",
        actor: "Court",
        message: "The filer wrote back on the filing thread.",
        createdAt: Date.now(),
      });
      return;
    }

    // 3. A new filing: the subject line is the claim; fall back to the body.
    const subject = cleanSubject(m.subject);
    const claim = subject.length >= 8 ? subject : text.split(/\r?\n/).find((l) => l.trim().length >= 8)?.trim() ?? "";
    if (claim.length < 8) {
      await agentmail.replyToMessage(ctx, inboxId, m.message_id, {
        text: "The Internet Claims Court could not find a claim in your message. Put the claim you want tried in the subject line, e.g. \"OpenAI solved the Navier-Stokes problem\", and send it again.",
        labels: ["bounce"],
      });
      return;
    }
    const caseId = await openCase(ctx, claim.slice(0, 600), {
      filingInboxId: inboxId,
      filingMessageId: m.message_id,
      filingThreadId: m.thread_id,
    });
    await ctx.db.insert("events", {
      caseId,
      kind: "mail",
      actor: "Court",
      message: "Case filed by email. An acknowledgment was sent to the filer.",
      createdAt: Date.now(),
    });
    await agentmail.replyToMessage(ctx, inboxId, m.message_id, {
      text: `The Internet Claims Court has docketed your claim:\n\n  "${claim}"\n\nA Clerk is splitting it into testable parts, Prosecution and Defense are gathering live evidence, and a Judge will rule on each part. Watch the trial live:\n\n  ${caseUrl(caseId)}\n\nYou will receive the verdict by reply, usually within ten minutes.`,
      labels: ["filing"],
    });
  },
});

async function handleSubpoenaReply(
  ctx: MutationCtx,
  inquiry: Doc<"inquiries">,
  m: InboundMessage,
  text: string,
  from: string,
) {
  if (inquiry.status === "replied") return;
  const now = Date.now();
  const sourceId = await ctx.db.insert("sources", {
    caseId: inquiry.caseId,
    url: `mailto:${inquiry.to}`,
    title: `Reply from ${inquiry.party} to the court's inquiry`,
    description: `Email reply received ${new Date(now).toISOString()}`,
    markdown: `Subject: ${m.subject ?? inquiry.subject}\nFrom: ${inquiry.party}\n\n${text}`,
    truncated: false,
    fetchedAt: now,
    query: "subpoena",
  });
  await ctx.db.patch(inquiry._id, {
    status: "replied",
    replyText: text.slice(0, 5000),
    replyFrom: from.slice(0, 200),
    repliedAt: now,
    threadId: m.thread_id,
  });
  const sub = await ctx.db.get(inquiry.subclaimId);
  await ctx.db.insert("events", {
    caseId: inquiry.caseId,
    subclaimId: inquiry.subclaimId,
    kind: "mail",
    actor: "Court",
    message: `${inquiry.party} replied to the court's inquiry on subclaim ${(sub?.index ?? 0) + 1}. Reopening the record.`,
    createdAt: now,
  });
  const c = await ctx.db.get(inquiry.caseId);
  if (!c || c.status !== "decided") return; // a retrial is already running; the reply stays on file
  const appealId = await openAppeal(ctx, {
    subclaimId: inquiry.subclaimId,
    kind: "subpoena_reply",
    argument: `${inquiry.party} answered the court's written inquiry. Their reply is on the record as a new source and must be weighed as a statement from the party itself.`,
    sourceId,
  });
  await ctx.db.patch(inquiry._id, { appealId });
}

// When a case filed by email is decided, send the verdict back on the thread.
export const notifyFiler = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const c = await ctx.db.get(caseId);
    if (!c?.filingInboxId || !c.filingMessageId || !c.verdict) return;
    const label = c.verdict.replace("_", " ").toUpperCase();
    await agentmail.replyToMessage(ctx, c.filingInboxId, c.filingMessageId, {
      text: `VERDICT: ${label} (Judge is ${Math.round(c.confidence ?? 0)}% confident)\n\nClaim: "${c.claim}"\n\n${c.summary ?? ""}\n\nWhat would change this ruling: ${c.whatWouldChange ?? ""}\n\nFull docket, exhibits, and objections:\n  ${caseUrl(caseId)}\n\nYou can appeal any subclaim ruling from the docket.`,
      labels: ["verdict"],
    });
    await ctx.db.insert("events", {
      caseId,
      kind: "mail",
      actor: "Court",
      message: "Verdict sent to the filer by email.",
      createdAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Subpoenas: the Clerk drafts; a person issues.
// ---------------------------------------------------------------------------
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Addresses that appear verbatim in the case's scraped sources. The Clerk may
// only address a subpoena to one of these, never to an address it imagines.
export const contactsOnRecord = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.array(v.object({ email: v.string(), url: v.string() })),
  handler: async (ctx, { caseId }) => {
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_case_url", (q) => q.eq("caseId", caseId))
      .take(60);
    const out = new Map<string, string>();
    for (const s of sources) {
      for (const hit of s.markdown.match(EMAIL_RE) ?? []) {
        const email = hit.toLowerCase();
        if (/\.(png|jpg|gif|svg|webp)$/.test(email)) continue;
        if (/^(noreply|no-reply|donotreply)@/.test(email)) continue;
        if (!out.has(email)) out.set(email, s.url);
      }
      if (out.size >= 40) break;
    }
    return [...out].map(([email, url]) => ({ email, url }));
  },
});

export const insertInquiries = internalMutation({
  args: {
    caseId: v.id("cases"),
    inquiries: v.array(
      v.object({
        subclaimId: v.id("subclaims"),
        party: v.string(),
        to: v.string(),
        subject: v.string(),
        body: v.string(),
      }),
    ),
  },
  handler: async (ctx, { caseId, inquiries }) => {
    const now = Date.now();
    for (const inq of inquiries) {
      await ctx.db.insert("inquiries", { caseId, ...inq, status: "draft", createdAt: now });
      const sub = await ctx.db.get(inq.subclaimId);
      await ctx.db.insert("events", {
        caseId,
        subclaimId: inq.subclaimId,
        kind: "mail",
        actor: "Clerk",
        message: `Drafted a subpoena to ${inq.party} on subclaim ${(sub?.index ?? 0) + 1}${inq.to ? "" : " (no address on record; needs one before it can issue)"}.`,
        createdAt: now,
      });
    }
  },
});

export const draftSubpoenas = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { caseId }): Promise<null> => {
    const c: Doc<"cases"> | null = await ctx.runQuery(internal.cases.getInternal, { caseId });
    if (!c) return null;
    const subs: Array<Doc<"subclaims"> & { ruling: Doc<"rulings"> | null }> = await ctx.runQuery(
      internal.cases.subclaimsWithRulings,
      { caseId },
    );
    const contacts: Array<{ email: string; url: string }> = await ctx.runQuery(
      internal.mail.contactsOnRecord,
      { caseId },
    );
    const open = subs.filter(
      (s) => s.ruling && ["unresolved", "unsupported", "misleading", "mostly_supported"].includes(s.ruling.verdict),
    );
    if (open.length === 0) return null;

    const subsBlock = open
      .map(
        (s) =>
          `Subclaim ${s.index + 1} (id ${s._id}): "${s.text}"\nRuling: ${s.ruling!.verdict} (${Math.round(s.ruling!.confidence)}%)\nWhat would change it: ${s.ruling!.whatWouldChange}`,
      )
      .join("\n\n");
    const contactsBlock =
      contacts.length === 0
        ? "(no email addresses appear in the record)"
        : contacts.map((k) => `${k.email}  <found on ${k.url}>`).join("\n");

    const { output } = await clerk.generateText(
      ctx,
      { threadId: c.threadId },
      {
        prompt: `Claim under review: "${c.claim}"\n\nThe court has ruled, but these subclaims turn on facts a specific party could settle:\n\n${subsBlock}\n\nEmail addresses that appear verbatim in the evidence on record:\n${contactsBlock}\n\nDraft at most 2 written inquiries (subpoenas) from the Internet Claims Court. Each names the party best placed to settle ONE subclaim (an organization, institution, or named individual), asks one or two precise, answerable questions, and explains that the reply will be entered into the public record. Tone: courteous, formal, brief (under 120 words). Give the party's own web domain as "partyDomain" (e.g. claymath.org). For "to", use an address from the list above ONLY if it belongs to that party's domain; reporters, commentators and third parties are never the party. Otherwise leave "to" empty and a person will supply one. Never invent an address.`,
        output: Output.object({
          schema: z.object({
            inquiries: z
              .array(
                z.object({
                  subclaimId: z.string(),
                  party: z.string(),
                  partyDomain: z.string().describe("the party's own web domain, e.g. openai.com"),
                  to: z.string().describe("email from the list at the party's domain, or empty"),
                  subject: z.string(),
                  body: z.string(),
                }),
              )
              .max(2),
          }),
        }),
      },
    );
    const allowed = new Set(contacts.map((k) => k.email));
    const valid = new Set(open.map((s) => String(s._id)));
    // An address is accepted only if it is on record AND at the party's own domain.
    const atParty = (to: string, domain: string) => {
      const d = domain.toLowerCase().replace(/^www\./, "").trim();
      const host = to.split("@")[1] ?? "";
      return d.length > 3 && (host === d || host.endsWith("." + d));
    };
    const drafts = (output?.inquiries ?? [])
      .filter((i) => valid.has(i.subclaimId))
      .map((i) => ({
        subclaimId: i.subclaimId as Id<"subclaims">,
        party: i.party.slice(0, 120),
        to:
          allowed.has(i.to.toLowerCase()) && atParty(i.to.toLowerCase(), i.partyDomain)
            ? i.to.toLowerCase()
            : "",
        subject: i.subject.slice(0, 200),
        body: i.body.slice(0, 2000),
      }));
    if (drafts.length > 0) await ctx.runMutation(internal.mail.insertInquiries, { caseId, inquiries: drafts });
    return null;
  },
});

// A person issues a drafted subpoena, optionally supplying or correcting the
// recipient. Nothing is ever emailed to a third party without this click.
export const issueSubpoena = mutation({
  args: { inquiryId: v.id("inquiries"), to: v.string() },
  returns: v.null(),
  handler: async (ctx, { inquiryId, to }) => {
    const inq = await ctx.db.get(inquiryId);
    if (!inq) throw new Error("Inquiry not found.");
    if (inq.status !== "draft") throw new Error("This inquiry has already been issued.");
    const addr = to.trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(addr)) throw new Error("Enter a valid email address.");
    const inboxId = await readSetting(ctx, "inboxId");
    if (!inboxId) throw new Error("The court's inbox is not set up on this deployment.");
    const c = await ctx.db.get(inq.caseId);
    const outboundId = await agentmail.sendMessage(ctx, inboxId, {
      to: addr,
      subject: inq.subject,
      text: `${inq.body}\n\n—\nInternet Claims Court\nThis inquiry concerns the public case "${c?.claim ?? ""}":\n${caseUrl(inq.caseId)}\nReplies to this message are entered into the public record of that case.`,
      labels: ["subpoena", String(inq.caseId)],
    });
    await ctx.db.patch(inquiryId, { to: addr, status: "sent", outboundId: String(outboundId), sentAt: Date.now() });
    const sub = await ctx.db.get(inq.subclaimId);
    await ctx.db.insert("events", {
      caseId: inq.caseId,
      subclaimId: inq.subclaimId,
      kind: "mail",
      actor: "Court",
      message: `Subpoena issued to ${inq.party} on subclaim ${(sub?.index ?? 0) + 1}. Awaiting reply.`,
      createdAt: Date.now(),
    });
    return null;
  },
});
