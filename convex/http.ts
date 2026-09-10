import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { agentmail } from "./mail";

// App-owned routes are mounted under /api (see convex.config.ts), so this
// handler is public at <deployment>.convex.site/api/agentmail/webhook.
const http = httpRouter();

http.route({
  path: "/agentmail/webhook",
  method: "POST",
  // The component was compiled against an older ctx signature; the runtime
  // shape is identical.
  handler: httpAction(async (ctx, req) =>
    agentmail.handleWebhook(ctx as unknown as Parameters<typeof agentmail.handleWebhook>[0], req),
  ),
});

export default http;
