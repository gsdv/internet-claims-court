import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  VERDICT_LABEL,
  VerdictBadge,
  host,
  timeAgo,
  verdictDot,
  type Verdict,
} from "../components/ui";

type Docket = NonNullable<ReturnType<typeof useDocket>>;
type Subclaim = Docket["subclaims"][number];
function useDocket(caseId: Id<"cases">) {
  return useQuery(api.cases.getDocket, { caseId });
}

const STATUS_LINE: Record<string, string> = {
  filed: "Case filed. Waiting for the Clerk.",
  decomposing: "Clerk is decomposing the claim into testable subclaims…",
  researching: "Counsel are gathering live evidence from the web…",
  judging: "Judge is deliberating…",
  decided: "Verdict entered.",
  failed: "Mistrial.",
};

export default function CaseView({
  caseId,
  navigate,
}: {
  caseId: Id<"cases">;
  navigate: (to: string) => void;
}) {
  const docket = useDocket(caseId);

  if (docket === undefined)
    return <main className="mx-auto max-w-6xl px-5 py-14 text-ink-3">Opening case file…</main>;
  if (docket === null)
    return (
      <main className="mx-auto max-w-6xl px-5 py-14">
        <p className="text-ink-3">No such case.</p>
        <button className="mt-3 underline" onClick={() => navigate("/")}>
          Back to docket
        </button>
      </main>
    );

  const c = docket.case;
  const live = c.status !== "decided" && c.status !== "failed";
  const totalExhibits = docket.stats.for + docket.stats.against;
  const revisions = docket.verdictHistory.length - 1;

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      {/* Case header */}
      <section className="rise">
        <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-[0.2em] text-ink-3">
          <span>Case No. {c._id.slice(-6).toUpperCase()}</span>
          <span>·</span>
          <span>Filed {timeAgo(c.createdAt)}</span>
          {revisions > 0 && (
            <>
              <span>·</span>
              <span className="text-gold">
                {revisions} {revisions === 1 ? "revision" : "revisions"}
              </span>
            </>
          )}
        </div>
        <h1 className="mt-3 font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
          “{c.claim}”
        </h1>

        <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4">
          <div>
            <VerdictBadge verdict={c.verdict as Verdict | undefined} size="lg" />
            {c.verdict && c.confidence !== undefined && (
              <p className="mt-1.5 font-mono text-[11px] text-ink-3">
                Judge is {Math.round(c.confidence)}% confident in this ruling
              </p>
            )}
          </div>
          {docket.subclaims.length > 0 && (
            <Scorecard subclaims={docket.subclaims} />
          )}
        </div>

        {docket.verdictHistory.length > 1 && (
          <p className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-ink-3">
            <span className="uppercase tracking-wider">History</span>
            {docket.verdictHistory.map((h, i) => (
              <span key={h.version} className="flex items-center gap-1.5">
                {i > 0 && <span>→</span>}
                <span className={h.verdict !== c.verdict ? "line-through" : "text-ink"}>
                  {VERDICT_LABEL[h.verdict as Verdict]} {Math.round(h.confidence)}%
                </span>
              </span>
            ))}
          </p>
        )}

        {c.status === "decided" && c.summary && (
          <div className="mt-6 max-w-3xl rounded-2xl border border-line bg-white/60 p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
              Opinion of the court
            </p>
            <p className="mt-2 text-lg leading-relaxed">{c.summary}</p>
            {c.whatWouldChange && (
              <p className="mt-3 text-sm text-ink-2">
                <span className="font-medium">What would change this ruling:</span>{" "}
                {c.whatWouldChange}
              </p>
            )}
          </div>
        )}
        {live && (
          <p className="mt-4 flex items-center gap-2 text-sm text-ink-2">
            <span className="live-dot inline-block size-2 rounded-full bg-seal" />
            {STATUS_LINE[c.status]}
          </p>
        )}
        {c.status === "failed" && <p className="mt-4 text-sm text-seal">Mistrial: {c.error}</p>}

        <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-3">
          Evidence on record · {totalExhibits} exhibits from {docket.stats.sources} sources ·{" "}
          {docket.stats.rejected} rejected by the Auditor
        </p>
      </section>

      <div className="docket-rule my-8" />

      <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
        {/* Subclaims */}
        <section className="space-y-6">
          {docket.subclaims.length === 0 && (
            <p className="text-ink-3">The Clerk has not docketed any subclaims yet.</p>
          )}
          {docket.subclaims.map((s) => (
            <SubclaimCard key={s._id} s={s} caseDecided={c.status === "decided"} />
          ))}
        </section>

        {/* Live feed */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-xl font-semibold">Court record</h2>
            {live && (
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-seal">
                <span className="live-dot inline-block size-1.5 rounded-full bg-seal" /> live
              </span>
            )}
          </div>
          <ol className="mt-3 max-h-[70vh] space-y-2 overflow-y-auto pr-1">
            {docket.events.map((e) => (
              <li key={e._id} className="rise flex gap-3 text-sm">
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${dotFor(e.kind)}`} />
                <div className="min-w-0">
                  <p className="leading-snug">
                    <span className="font-medium">{e.actor}</span>{" "}
                    <span className="text-ink-2">{e.message}</span>
                  </p>
                  <p className="font-mono text-[10px] text-ink-3">{timeAgo(e.createdAt)}</p>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </main>
  );
}

// The verdict explained by its parts: one chip per subclaim ruling.
function Scorecard({ subclaims }: { subclaims: Subclaim[] }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
        Subclaim rulings
      </p>
      <ol className="mt-1.5 flex flex-wrap gap-1.5">
        {subclaims.map((s) => (
          <li key={s._id}>
            <a
              href={`#subclaim-${s.index + 1}`}
              title={s.text}
              className="flex items-center gap-1.5 rounded-full border border-line bg-white/60 py-1 pl-1.5 pr-2.5 font-mono text-[11px] hover:border-ink-3"
            >
              <span
                className={`inline-block size-2.5 rounded-full ${verdictDot(s.verdict as Verdict | undefined)} ${s.verdict ? "" : "live-dot"}`}
              />
              <span className="text-ink-3">{s.index + 1}</span>
              <span>
                {s.verdict ? VERDICT_LABEL[s.verdict as Verdict] : "Pending"}
                {s.confidence !== undefined && (
                  <span className="text-ink-3"> {Math.round(s.confidence)}%</span>
                )}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function dotFor(kind: string) {
  switch (kind) {
    case "exhibit":
      return "bg-for";
    case "exhibit_rejected":
    case "error":
      return "bg-against";
    case "objection":
      return "bg-seal/60";
    case "ruling":
    case "verdict":
    case "audit":
      return "bg-gold";
    case "appeal":
      return "bg-ink";
    case "search":
      return "bg-ink-3";
    default:
      return "bg-line";
  }
}

function SubclaimCard({ s, caseDecided }: { s: Subclaim; caseDecided: boolean }) {
  const forEx = s.exhibits.filter((e) => e.side === "for");
  const againstEx = s.exhibits.filter((e) => e.side === "against");
  const objectionsByExhibit = new Map<number, Subclaim["objections"]>();
  for (const o of s.objections) {
    objectionsByExhibit.set(o.exhibitNumber, [
      ...(objectionsByExhibit.get(o.exhibitNumber) ?? []),
      o,
    ]);
  }
  const pendingAppeal = s.appeals.find((a) => a.status === "filed");
  const heardAppeals = s.appeals.filter((a) => a.status !== "filed");

  return (
    <article
      id={`subclaim-${s.index + 1}`}
      className="rise scroll-mt-6 rounded-2xl border border-line bg-white/50 p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
            Subclaim {s.index + 1} · {s.status}
            {s.ruling && s.ruling.version > 1 && ` · ruling v${s.ruling.version}`}
          </p>
          <h3 className="mt-1 font-display text-xl font-semibold leading-snug">{s.text}</h3>
          <p className="mt-1 text-sm text-ink-2">{s.whyItMatters}</p>
        </div>
        <VerdictBadge verdict={s.verdict as Verdict | undefined} confidence={s.confidence} size="sm" />
      </div>

      {s.ruling && (
        <div className="mt-4 rounded-xl bg-paper-2 p-4 text-sm leading-relaxed">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
            Ruling{s.priorRulings.length > 0 && " (on appeal)"}
          </p>
          <p className="mt-1">{s.ruling.reasoning}</p>
          <p className="mt-2 text-ink-2">
            <span className="font-medium">Would change it:</span> {s.ruling.whatWouldChange}
          </p>
          {s.priorRulings.length > 0 && (
            <details className="mt-2 text-xs text-ink-3">
              <summary className="cursor-pointer font-mono uppercase tracking-wider">
                Prior rulings
              </summary>
              {s.priorRulings.map((r) => (
                <p key={r._id} className="mt-1.5">
                  <span className="font-medium">
                    v{r.version} · {VERDICT_LABEL[r.verdict as Verdict]} {Math.round(r.confidence)}%
                  </span>{" "}
                  {r.reasoning}
                </p>
              ))}
            </details>
          )}
        </div>
      )}

      {s.exhibits.length > 0 && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <ExhibitColumn title="Prosecution" tone="text-for" items={forEx} objections={objectionsByExhibit} />
          <ExhibitColumn title="Defense" tone="text-against" items={againstEx} objections={objectionsByExhibit} />
        </div>
      )}

      {heardAppeals.map((a) => (
        <div key={a._id} className="mt-4 rounded-xl border border-dashed border-line p-3 text-sm">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
            Appeal {a.status === "heard" ? "heard" : "failed"} · {timeAgo(a.createdAt)}
          </p>
          <p className="mt-1 italic text-ink-2">“{a.argument}”</p>
          {a.url && (
            <a href={a.url} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-ink-3 underline">
              {host(a.url)}
            </a>
          )}
          {a.error && <p className="mt-1 text-xs text-seal">{a.error}</p>}
        </div>
      ))}

      {pendingAppeal ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-ink-2">
          <span className="live-dot inline-block size-2 rounded-full bg-seal" />
          Appeal is being heard…
        </p>
      ) : (
        s.ruling && caseDecided && <AppealForm subclaimId={s._id} />
      )}
    </article>
  );
}

function AppealForm({ subclaimId }: { subclaimId: Id<"subclaims"> }) {
  const [open, setOpen] = useState(false);
  const [argument, setArgument] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileAppeal = useMutation(api.cases.fileAppeal);

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 rounded-full border border-line px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-ink-2 hover:border-ink-3 hover:text-ink"
      >
        Appeal this ruling
      </button>
    );

  return (
    <form
      className="mt-4 space-y-2 rounded-xl border border-line bg-white/70 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await fileAppeal({ subclaimId, argument, url: url || undefined });
          setOpen(false);
          setArgument("");
          setUrl("");
        } catch (err) {
          setError((err as Error).message.replace(/^.*Uncaught Error: /, "").split("\n")[0]);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">Notice of appeal</p>
      <textarea
        value={argument}
        onChange={(e) => setArgument(e.target.value)}
        rows={3}
        placeholder="Why is this ruling wrong? What did the court miss?"
        className="w-full resize-none rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-ink-3"
      />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Link to new evidence (optional)"
        className="w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs outline-none focus:border-ink-3"
      />
      {error && <p className="text-xs text-seal">{error}</p>}
      <div className="flex gap-2">
        <button
          disabled={busy || argument.trim().length < 10}
          className="rounded-lg bg-ink px-3 py-1.5 text-sm text-paper disabled:opacity-40"
        >
          {busy ? "Filing…" : "File appeal"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg px-3 py-1.5 text-sm text-ink-2"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ExhibitColumn({
  title,
  tone,
  items,
  objections,
}: {
  title: string;
  tone: string;
  items: Subclaim["exhibits"];
  objections: Map<number, Subclaim["objections"]>;
}) {
  return (
    <div>
      <p className={`font-mono text-[10px] uppercase tracking-[0.2em] ${tone}`}>
        {title} · {items.filter((e) => e.verified).length}
      </p>
      <ul className="mt-2 space-y-3">
        {items.length === 0 && <li className="text-xs text-ink-3">Nothing filed.</li>}
        {items.map((e) => {
          const objs = objections.get(e.number) ?? [];
          return (
            <li
              key={e._id}
              className={`rise rounded-lg border p-3 text-sm ${
                e.verified ? "border-line bg-white/70" : "border-dashed border-against/40 bg-against/5"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                  Ex. {e.number} · {e.sourceType}
                </span>
                <span className="flex items-center gap-2">
                  {e.sourceScore !== undefined && (
                    <span
                      title={e.sourceScoreNote}
                      className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${scoreTone(e.sourceScore)}`}
                    >
                      {Math.round(e.sourceScore)}
                    </span>
                  )}
                  <span
                    className={`font-mono text-[10px] uppercase tracking-wider ${
                      e.verified ? "text-for" : "text-against"
                    }`}
                    title={e.verificationNote}
                  >
                    {e.verified ? "✓ verified" : "✕ rejected"}
                  </span>
                </span>
              </div>
              <blockquote className="mt-1.5 border-l-2 border-line pl-2 italic leading-snug text-ink">
                “{e.quote}”
              </blockquote>
              <p className="mt-1.5 text-ink-2">{e.note}</p>
              <a
                href={e.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block max-w-full truncate font-mono text-[11px] text-ink-3 underline decoration-line hover:text-ink"
              >
                {host(e.url)} · {e.title.slice(0, 60)}
              </a>
              {objs.map((o) => (
                <p
                  key={o._id}
                  className="mt-2 rounded-md bg-seal/5 px-2 py-1.5 text-xs leading-snug text-ink-2"
                >
                  <span className="font-mono uppercase tracking-wider text-seal">
                    Objection · {o.kind.replace(/_/g, " ")} · sev {o.severity}
                  </span>{" "}
                  {o.text}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function scoreTone(score: number) {
  if (score >= 70) return "bg-for/15 text-for";
  if (score >= 40) return "bg-gold/20 text-gold";
  return "bg-against/15 text-against";
}
