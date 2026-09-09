import { httpRouter } from "convex/server";

// App-owned routes are mounted under /api (see convex.config.ts). The static
// site owns "/", and the Firecrawl component owns "/firecrawl/".
// AgentMail's inbound webhook will be registered here in a later phase.
const http = httpRouter();

export default http;
