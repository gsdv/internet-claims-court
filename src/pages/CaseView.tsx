import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Stat, VerdictBadge, host, timeAgo, type Verdict } from "../components/ui";

type Docket = NonNullable<ReturnType<typeof useDocket>>;
function useDocket(caseId: Id<"cases">) {
  return useQuery(api.cases.getDocket, { caseId });
}

const STATUS_LINE: Record<string, string> = {
  filed: "Case filed. Waiting for the Clerk.",
  decomposing: "Clerk is decomposing the claim into testable subclaims…",
  researching: "Researchers are gathering live evidence from the web…",
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

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      {/* Case header */}
      <section className="rise">
        <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-[0.2em] text-ink-3">
          <span>Case No. {c._id.slice(-6).toUpperCase()}</span>
          <span>·</span>
          <span>Filed {timeAgo(c.createdAt)}</span>
        </div>
        <h1 className="mt-3 font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
          “{c.claim}”
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-6">
          <VerdictBadge verdict={c.verdict as Verdict | undefined} confidence={c.confidence} size="lg" />
          <Stat label="For" value={docket.stats.for} tone="text-for" />
          <Stat label="Against" value={docket.stats.against} tone="text-against" />
          <Stat label="Rejected" value={docket.stats.rejected} tone="text-ink-3" />
          <Stat label="Sources" value={docket.stats.sources} />
        </div>
        {c.status === "decided" && c.summary && (
          <div className="mt-6 max-w-3xl rounded-2xl border border-line bg-white/60 p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">Opinion of the court</p>
            <p className="mt-2 text-lg leading-relaxed">{c.summary}</p>
            {c.whatWouldChange && (
              <p className="mt-3 text-sm text-ink-2">
                <span className="font-medium">What would change this ruling:</span> {c.whatWouldChange}
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
        {c.status === "failed" && (
          <p className="mt-4 text-sm text-seal">Mistrial: {c.error}</p>
        )}
      </section>

      <div className="docket-rule my-8" />

      <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
        {/* Subclaims */}
        <section className="space-y-6">
          {docket.subclaims.length === 0 && (
            <p className="text-ink-3">The Clerk has not docketed any subclaims yet.</p>
          )}
          {docket.subclaims.map((s) => (
            <SubclaimCard key={s._id} s={s} />
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

function dotFor(kind: string) {
  switch (kind) {
    case "exhibit":
      return "bg-for";
    case "exhibit_rejected":
    case "error":
      return "bg-against";
    case "ruling":
    case "verdict":
      return "bg-gold";
    case "search":
      return "bg-ink-3";
    default:
      return "bg-line";
  }
}

function SubclaimCard({ s }: { s: Docket["subclaims"][number] }) {
  const forEx = s.exhibits.filter((e) => e.side === "for");
  const againstEx = s.exhibits.filter((e) => e.side === "against");
  return (
    <article className="rise rounded-2xl border border-line bg-white/50 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
            Subclaim {s.index + 1} · {s.status}
          </p>
          <h3 className="mt-1 font-display text-xl font-semibold leading-snug">{s.text}</h3>
          <p className="mt-1 text-sm text-ink-2">{s.whyItMatters}</p>
        </div>
        <VerdictBadge verdict={s.verdict as Verdict | undefined} confidence={s.confidence} size="sm" />
      </div>

      {s.ruling && (
        <div className="mt-4 rounded-xl bg-paper-2 p-4 text-sm leading-relaxed">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">Ruling</p>
          <p className="mt-1">{s.ruling.reasoning}</p>
          <p className="mt-2 text-ink-2">
            <span className="font-medium">Would change it:</span> {s.ruling.whatWouldChange}
          </p>
        </div>
      )}

      {s.exhibits.length > 0 && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <ExhibitColumn title="For" tone="text-for" items={forEx} />
          <ExhibitColumn title="Against" tone="text-against" items={againstEx} />
        </div>
      )}
    </article>
  );
}

function ExhibitColumn({
  title,
  tone,
  items,
}: {
  title: string;
  tone: string;
  items: Docket["subclaims"][number]["exhibits"];
}) {
  return (
    <div>
      <p className={`font-mono text-[10px] uppercase tracking-[0.2em] ${tone}`}>
        {title} · {items.length}
      </p>
      <ul className="mt-2 space-y-3">
        {items.length === 0 && <li className="text-xs text-ink-3">None on record.</li>}
        {items.map((e) => (
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
              <span
                className={`font-mono text-[10px] uppercase tracking-wider ${
                  e.verified ? "text-for" : "text-against"
                }`}
                title={e.verificationNote}
              >
                {e.verified ? "✓ verified" : "✕ rejected"}
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
              className="mt-1 inline-block truncate font-mono text-[11px] text-ink-3 underline decoration-line hover:text-ink"
            >
              {host(e.url)} · {e.title.slice(0, 60)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
