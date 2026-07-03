import { always } from "eve/tools/approval";
import { defineMcpClientConnection } from "eve/connections";

import { requireEnv } from "../lib/env.js";

/** MCP connection "docs" (workflow CONTEXT pillar). */
export default defineMcpClientConnection({
  url: "https://docs.example.com/mcp",
  description: "Internal docs: search support runbooks, product pages, and owners.",
  // Lazy callback: env vars are read per request, never at module load.
  headers: () => ({
    "X-Api-Key": requireEnv("MCP_DOCS_API_KEY"),
  }),
  tools: { block: ["delete_page", "publish_page"] },
  approval: always(),
});
