# Hackathon log

- **Project:** Internet Claims Court
- **Event:** Convex All Gas Hackathon (OpenAI, Firecrawl, AgentMail)
- **What it does:** Tries a contested claim in the open: a Clerk splits it into subclaims, Researchers pull live web evidence with Firecrawl, an Auditor verifies every quote against the scraped source, and a Judge rules on each subclaim and the case, all streamed to a live docket.
- **Live app:** https://successful-deer-432.convex.site
- **Repo:** https://github.com/gsdv/internet-claims-court
- **Frontend:** Convex static hosting
- **Convex deployment:** https://successful-deer-432.convex.cloud
- **Components:** @convex-dev/agent, @convex-dev/workflow, @convex-dev/static-hosting, @firecrawl/firecrawl-convex
- **Convex features:** schema, tables, indexes, queries, mutations, actions, realtime queries, HTTP actions, workflows, registered components
- **Auth:** none
- **AI models:** gpt-5.4-mini (Clerk, Researcher), gpt-5.4 (Judge)
- **Started:** 2026-09-09T21:30:18Z
- **Last updated:** 2026-09-10T04:55:00Z

## Log

### 2026-09-09 - f598ffb
Scaffolded the court. Cases, subclaims, sources, exhibits, rulings, and events
tables with per-case indexes (`convex/schema.ts`). A durable trial workflow
decomposes the claim, researches every subclaim in parallel, rules on each, then
synthesizes a case verdict; failures mark the case a mistrial via the workflow's
onComplete hook (`convex/trial.ts`, @convex-dev/workflow). Clerk, Researcher,
and Judge agents run on OpenAI through the Agent component with one thread per
case (`convex/agents.ts`). Researchers search web and news through the Firecrawl
component and scrape each hit; every exhibit must carry a verbatim quote, which
the Auditor string-matches against the stored page markdown before it is
admitted (`convex/research.ts`). The docket page subscribes to one reactive
query for the case, subclaims, exhibits, rulings, and event feed
(`convex/cases.ts`, `src/pages/CaseView.tsx`). Convex features: schema,
indexes, queries, mutations, actions, realtime queries, workflow, components.

### 2026-09-09 - 5fa6496
First full trial ran end to end on the dev deployment against the claim "OpenAI
solved the Navier-Stokes Millennium Prize problem": 5 subclaims, 28 exhibits
from 18 sources, 4 quotes rejected by the Auditor, verdict "misleading" because
the announcement is real but no independent or Clay Institute verification
exists. Broke a circular type-inference loop between the workflow and its
actions with explicit handler return types, bounded all docket reads with
`take`, and added a Vite launch config (`convex/research.ts`, `convex/trial.ts`,
`convex/cases.ts`).

### 2026-09-09 - c308e57
Published the app. Backend pushed to the production deployment and the Vite
build uploaded through the static hosting component, so the docket is live at a
public convex.site URL. Made the deploy script non-interactive
(`package.json`). Public repository created and pushed.

### 2026-09-10 - 351ed41
Made the trial adversarial. Prosecution and Defense now file from the same
pages in parallel, an Auditor scores every source 0-100 for reliability on
that specific subclaim, and a Cross-Examiner files typed objections
(unsupported leap, scope, stale, conflict of interest, secondary, duplicate)
that the Judge weighs (`convex/agents.ts`, `convex/research.ts`). Users can
appeal any subclaim ruling with an argument and an optional evidence URL; a
second workflow scrapes the link with Firecrawl, re-argues, re-audits,
re-examines and re-rules only that subclaim, then re-synthesizes the case
verdict, with rulings and verdicts versioned so revisions are visible
(`convex/trial.ts`, `convex/cases.ts`, `src/pages/CaseView.tsx`). Fixed a
scoreboard that read as a vote: the header now shows one chip per subclaim
ruling and labels confidence as the Judge's confidence in the ruling. The Clerk
may no longer write negated subclaims; thin, paywalled and social pages are
discarded before counsel read; and a quote already on the record is rejected
at filing so a side cannot refile the other's evidence (`convex/lib/quotes.ts`).
Tested end to end on the dev deployment: first appeal on the Navier-Stokes case
fetched a TechCrunch report, added 5 exhibits, drew 4 objections, and the Judge
affirmed with reasons addressed to the appellant. Convex features: workflows,
actions, mutations, realtime queries, components.
