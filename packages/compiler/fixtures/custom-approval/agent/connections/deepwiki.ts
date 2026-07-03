import { never } from "eve/tools/approval";
import { defineMcpClientConnection } from "eve/connections";

/** MCP connection "deepwiki" (workflow CONTEXT pillar). */
export default defineMcpClientConnection({
  url: "https://mcp.deepwiki.com/mcp",
  description: "DeepWiki: AI-generated documentation for public GitHub repositories.",
  approval: never(),
});
