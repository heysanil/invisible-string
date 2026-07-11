import { once } from "eve/tools/approval";
import { defineMcpClientConnection } from "eve/connections";

import { requireEnv } from "../lib/env.js";

/** MCP connection "deepwiki" (agent context). */
export default defineMcpClientConnection({
  url: "https://mcp.deepwiki.com/mcp",
  description: "DeepWiki: AI-generated documentation for public GitHub repositories. Use to look up a repo's structure, docs, or answer questions about its code.",
  auth: {
    // Lazy: probed per tool call, so keyless builds/boots never crash.
    getToken: async () => ({ token: requireEnv("MCP_DEEPWIKI_TOKEN") }),
  },
  tools: { allow: ["read_wiki_structure", "read_wiki_contents", "ask_question"] },
  approval: once(),
});
