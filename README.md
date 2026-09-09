# Internet Claims Court

File a claim. Watch it get tried.

Paste a headline, a hot take, or a viral claim. A **Clerk** splits it into
testable subclaims, **Researchers** pull live evidence from the web with
Firecrawl, an **Auditor** verifies every quote against the scraped source, and a
**Judge** rules on each subclaim in the open. The docket updates live as
exhibits are filed, rejected, and ruled on.

Built for the Convex All Gas Hackathon (OpenAI · Firecrawl · AgentMail).

## Stack

- **Convex** — database, durable trial workflow, live docket, static hosting
  - components: `@convex-dev/agent`, `@convex-dev/workflow`,
    `@firecrawl/firecrawl-convex`, `@convex-dev/static-hosting`
- **OpenAI** — Clerk / Researcher / Judge agents (via the Convex Agent component)
- **Firecrawl** — web + news search and page scraping for evidence discovery
- **AgentMail** — subpoenas to real parties and file-by-email (later phase)

## Develop

```bash
npm install
npx convex dev          # creates/links the deployment, generates types
npx convex env set OPENAI_API_KEY sk-...
npx convex env set FIRECRAWL_API_KEY fc-...
npm run dev             # vite + convex dev
```

## Deploy

```bash
npm run deploy          # builds, pushes backend, uploads static site to <deployment>.convex.site
```
