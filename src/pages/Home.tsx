import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { VerdictBadge, timeAgo } from "../components/ui";

const EXAMPLES = [
  "OpenAI solved the Navier-Stokes Millennium Prize problem",
  "Remote work reduces employee productivity",
  "Apple is carbon neutral",
];

export default function Home({ navigate }: { navigate: (to: string) => void }) {
  const [claim, setClaim] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileClaim = useMutation(api.cases.fileClaim);
  const cases = useQuery(api.cases.listCases);

  const submit = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      const id = await fileClaim({ claim: text });
      navigate(`/case/${id}`);
    } catch (e) {
      setError((e as Error).message.replace(/^.*Uncaught Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-5 py-14">
      <section className="max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-seal">Now hearing claims</p>
        <h1 className="mt-3 font-display text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
          File a claim.
          <br />
          Watch it get tried.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-ink-2">
          Paste a headline, a hot take, or a viral claim. A Clerk splits it into
          testable parts, Researchers pull live evidence from the web, an Auditor
          verifies every quote against the source, and a Judge rules on each part
          in the open. No black-box answers.
        </p>

        <form
          className="mt-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (claim.trim()) void submit(claim);
          }}
        >
          <div className="flex flex-col gap-3 rounded-2xl border border-line bg-white/60 p-3 shadow-sm sm:flex-row">
            <textarea
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              rows={2}
              placeholder='e.g. "OpenAI solved the Navier-Stokes problem"'
              className="flex-1 resize-none bg-transparent px-2 py-1 text-lg outline-none placeholder:text-ink-3"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (claim.trim()) void submit(claim);
                }
              }}
            />
            <button
              disabled={busy || claim.trim().length < 8}
              className="rounded-xl bg-ink px-5 py-3 font-medium text-paper transition hover:bg-ink-2 disabled:opacity-40"
            >
              {busy ? "Filing…" : "File claim"}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-seal">{error}</p>}
        </form>

        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setClaim(ex)}
              className="rounded-full border border-line bg-paper-2 px-3 py-1 text-sm text-ink-2 hover:border-ink-3"
            >
              {ex}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-16">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-2xl font-semibold">Public docket</h2>
          <span className="font-mono text-xs text-ink-3">{cases?.length ?? 0} cases</span>
        </div>
        <div className="docket-rule mt-3" />
        <ul className="divide-y divide-line">
          {cases === undefined && <li className="py-6 text-ink-3">Loading…</li>}
          {cases?.length === 0 && (
            <li className="py-6 text-ink-3">No cases yet. Be the first plaintiff.</li>
          )}
          {cases?.map((c) => (
            <li key={c._id}>
              <a
                href={`/case/${c._id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/case/${c._id}`);
                }}
                className="flex items-center justify-between gap-4 py-4 hover:bg-paper-2/60"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">“{c.claim}”</p>
                  <p className="font-mono text-xs text-ink-3">
                    {c.status === "decided" ? "Decided" : "In session"} · {timeAgo(c.createdAt)}
                  </p>
                </div>
                <VerdictBadge verdict={c.verdict} confidence={c.confidence} size="sm" />
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
