import { defineApp } from "convex/server";
import { v } from "convex/values";
import agent from "@convex-dev/agent/convex.config";
import workflow from "@convex-dev/workflow/convex.config";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import agentmail from "@agentmail/convex/convex.config";

// App-owned HTTP routes (webhooks, etc.) live under /api so the static site
// can own the root of <deployment>.convex.site.
const app = defineApp({
  httpPrefix: "/api",
  env: {
    FIRECRAWL_API_KEY: v.string(),
    FIRECRAWL_WEBHOOK_SECRET: v.optional(v.string()),
    AGENTMAIL_API_KEY: v.string(),
  },
});

app.use(agent);
app.use(workflow);
app.use(firecrawl, {
  httpPrefix: "/firecrawl/",
  env: {
    FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY,
    FIRECRAWL_WEBHOOK_SECRET: app.env.FIRECRAWL_WEBHOOK_SECRET,
  },
});
app.use(agentmail);
app.use(staticHosting, { httpPrefix: "/" });

export default app;
