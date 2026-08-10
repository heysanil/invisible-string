import { once } from "eve/tools/approval";
import { defineMcpClientConnection } from "eve/connections";

import { platformConnectionToken } from "../lib/platform-token.js";

/** MCP connection "linear" (agent context). */
export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear: search, create, and update issues, projects, and comments in the team's Linear workspace.",
  auth: {
    // Broker-delivered: the platform mints short-lived access tokens; no OAuth
    // material lives in agent env. Lazy so keyless builds never crash.
    getToken: async () => ({ token: await platformConnectionToken("cn_ab12cd34ef56gh78") }),
  },
  approval: once(),
});
