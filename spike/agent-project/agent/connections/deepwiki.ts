import { defineMcpClientConnection } from "eve/connections";

/**
 * Public no-auth MCP server (verified reachable 2026-07-02: streamable HTTP,
 * initialize handshake returns serverInfo "DeepWiki"). Overridable so tests
 * can point at a local stub when offline.
 */
export default defineMcpClientConnection({
  url: process.env.SPIKE_MCP_URL ?? "https://mcp.deepwiki.com/mcp",
  description:
    "DeepWiki: AI-generated documentation for public GitHub repositories. Use to look up a repo's structure, docs, or answer questions about its code.",
});
