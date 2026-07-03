/**
 * Local stub server (run under BUN) that fronts two things the harness needs:
 *
 *  1. A protocol-correct MCP server at POST /mcp, built on the official SDK's
 *     StreamableHTTPServerTransport (stateless). eve connects here with the AI
 *     SDK's Streamable-HTTP MCP client, so a hand-rolled JSON responder is not
 *     enough — the transport must speak the real handshake. Exposes one tool,
 *     `save_note` (eve names it `<connection>__save_note`), which the mock
 *     model calls when a message mentions it.
 *  2. The MCP registry REST API (GET /v0.1/servers[/…]) so the control-plane's
 *     registry proxy (redirected here via MCP_REGISTRY_BASE_URL) resolves both
 *     the search and the server-side install re-fetch without the real
 *     registry.
 *
 * Bound to 127.0.0.1 so the agent process (localhost worker) reaches it while
 * nothing external can. GET /__calls reports tool invocations for assertions.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { PORTS } from "../config.ts";

const callLog: { name: string; args: unknown }[] = [];

/** Canned registry server (remote points back at this stub's MCP endpoint). */
const REGISTRY_SERVER = {
  name: "io.modelcontextprotocol/e2e-notes",
  title: "E2E Notes (registry)",
  description: "A registry-listed notes server, stubbed for E2E.",
  version: "1.2.0",
  status: "active",
  // A DISTINCT path from the custom-URL connection's /mcp so eve loads both
  // connections (same URL would dedupe to one, hiding a tool prefix).
  remotes: [{ type: "streamable-http", url: `http://127.0.0.1:${PORTS.stubMcp}/mcp-b` }],
  _meta: {
    "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true },
  },
};

/** A fresh MCP server per request (stateless transport). */
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "e2e-stub-notes", version: "1.0.0" });
  server.registerTool(
    "save_note",
    {
      description: "Save a short note to the user's notebook.",
      inputSchema: { note: z.string().describe("The note text to save.") },
    },
    async ({ note }) => {
      callLog.push({ name: "save_note", args: { note } });
      return { content: [{ type: "text", text: `note saved: ${note}` }] };
    },
  );
  return server;
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORTS.stubMcp}`);

  if (url.pathname === "/__calls") {
    sendJson(res, { calls: callLog });
    return;
  }
  // MCP registry REST API (control-plane proxy is redirected here).
  if (url.pathname === "/v0.1/servers") {
    sendJson(res, { servers: [REGISTRY_SERVER] });
    return;
  }
  if (url.pathname.startsWith("/v0.1/servers/")) {
    sendJson(res, REGISTRY_SERVER);
    return;
  }

  if (url.pathname === "/mcp" || url.pathname === "/mcp-b") {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    let body: unknown;
    try {
      body = req.method === "POST" ? await readJsonBody(req) : undefined;
    } catch {
      body = undefined;
    }
    const method =
      body && typeof body === "object" && "method" in body
        ? (body as { method?: string }).method
        : undefined;
    console.log(`[e2e:stub-mcp] ${req.method} /mcp ${method ?? ""}`.trim());
    await transport.handleRequest(req, res, body);
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

httpServer.listen(PORTS.stubMcp, "127.0.0.1", () => {
  console.log(`[e2e:stub-mcp] listening on http://127.0.0.1:${PORTS.stubMcp} (mcp + registry)`);
});

process.on("SIGTERM", () => {
  httpServer.close();
  process.exit(0);
});
