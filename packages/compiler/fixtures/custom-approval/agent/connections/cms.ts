import { defineMcpClientConnection } from "eve/connections";

import { requireEnv } from "../lib/env.js";

/**
 * Per-tool approval policy. Connection tool names arrive QUALIFIED as
 * "cms__<tool>" (eve prefixes the connection slug), so the lists below
 * bake the qualified names at compile time.
 */
const DENY_TOOLS: readonly string[] = ["cms__delete_page"];
const ASK_TOOLS: readonly string[] = ["cms__publish_page"];
const ALLOW_TOOLS: readonly string[] = ["cms__get_page"];

/** MCP connection "cms" (workflow CONTEXT pillar). */
export default defineMcpClientConnection({
  url: "https://cms.example.com/mcp",
  description: "Company CMS: create, update, publish, and delete pages.",
  auth: {
    // Lazy: probed per tool call, so keyless builds/boots never crash.
    getToken: async () => ({ token: requireEnv("MCP_CMS_TOKEN") }),
  },
  tools: { allow: ["get_page", "create_draft", "publish_page", "delete_page"] },
  approval: ({ toolName }) => {
    if (DENY_TOOLS.includes(toolName)) return "denied";
    if (ASK_TOOLS.includes(toolName)) return "user-approval";
    if (ALLOW_TOOLS.includes(toolName)) return "not-applicable";
    return "user-approval";
  },
});
