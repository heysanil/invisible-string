/**
 * Local stub server (run under BUN) that fronts three things the harness
 * needs:
 *
 *  1. A protocol-correct MCP server at POST /mcp, built on the official SDK's
 *     StreamableHTTPServerTransport (stateless). eve connects here with the AI
 *     SDK's Streamable-HTTP MCP client, so a hand-rolled JSON responder is not
 *     enough — the transport must speak the real handshake. Exposes one tool,
 *     `save_note` (eve names it `<connection>__save_note`), which the mock
 *     model calls when a message mentions it.
 *  2. The MCP registry REST API (GET /v0.1/servers[/…]) so the control plane
 *     (redirected here via MCP_REGISTRY_BASE_URL) resolves both the
 *     registry→Meilisearch sync ETL (which pages the list into the community
 *     search index) and the server-side install re-fetch without the real
 *     registry. The fixture carries `_meta` isLatest/status so the sync's
 *     entry→action mapping ingests it, and its remote declares a secret
 *     header so the add-connection dialog's credential form is exercised.
 *  3. An OAUTH-PROTECTED MCP endpoint at /mcp-oauth (oauth-connection spec):
 *     EVERY request — the handshake included — demands `Authorization:
 *     Bearer <token>` validated against the stub AS (scripts/stub-as.ts,
 *     POST /__introspect); anything else gets a 401 carrying the RFC 9728
 *     `WWW-Authenticate` challenge (the `resource_metadata` pointer plus the
 *     `scope` this request lacked). The PRM at the path-aware well-known
 *     names the stub AS, so the control plane's real discovery → DCR →
 *     consent → token chain runs against it.
 *
 *     THIS GATE IS THE POINT (2026-08-31 OAuth fix plan F1/P1.3). The fixture
 *     used to leave `initialize`/`tools/list` OPEN and said so in this
 *     comment, to accommodate a probe that dialled with static headers only —
 *     so the spec's post-consent `ok` was certifying the bug: the health
 *     probe never read the broker's token, every real OAuth MCP server
 *     (Vercel, Linear, Notion, Sentry — all verified live) 401s an
 *     unauthenticated handshake, and no OAuth connection anywhere ever
 *     populated `tools_cache`. Closing the handshake makes the fixture behave
 *     like the servers it stands in for: post-consent health can only reach
 *     `ok`, and the tool picker can only fill, if the probe presents a
 *     broker-delivered bearer the AS says is active. Never reopen it.
 *
 * Bound to 127.0.0.1 so the agent process (localhost worker) reaches it while
 * nothing external can. GET /__calls reports tool invocations (plus the
 * /mcp-oauth request log — http method, rpc method, and whether a VALID
 * bearer was carried; token values never appear in any response or log line)
 * for assertions.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  PORTS,
  REGISTRY_SECRET_HEADER,
  REGISTRY_SERVER_NAME,
  REGISTRY_SERVER_TITLE,
  STUB_AS_URL,
  STUB_OAUTH_MCP_URL,
} from "../config.ts";

const callLog: { name: string; args: unknown }[] = [];
/** Tool invocations that arrived through the OAuth-gated /mcp-oauth. */
const oauthCallLog: { name: string; args: unknown }[] = [];
/**
 * Every /mcp-oauth request: HTTP method, rpc method (`?` when there is no
 * JSON-RPC body — the discovery GET), and whether it carried a bearer the AS
 * says is active. Token VALUES never appear here or in any log line.
 */
const oauthRequestLog: {
  httpMethod: string;
  rpcMethod: string;
  authValid: boolean;
}[] = [];

/** Canned registry server (remote points back at this stub's MCP endpoint). */
const REGISTRY_SERVER = {
  name: REGISTRY_SERVER_NAME,
  title: REGISTRY_SERVER_TITLE,
  description: "A registry-listed notes server, stubbed for E2E.",
  version: "1.2.0",
  status: "active",
  remotes: [
    {
      type: "streamable-http",
      // A DISTINCT path from the custom-URL connection's /mcp so eve loads both
      // connections (same URL would dedupe to one, hiding a tool prefix).
      url: `http://127.0.0.1:${PORTS.stubMcp}/mcp-b`,
      // A declared secret header makes the add dialog collect a credential
      // before installing (the stub itself ignores request headers).
      headers: [
        {
          name: REGISTRY_SECRET_HEADER,
          description: "Notes API key",
          isRequired: true,
          isSecret: true,
        },
      ],
    },
  ],
  // The sync ETL's entry→action mapping requires active+isLatest to upsert.
  _meta: {
    "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true },
  },
};

/** A fresh MCP server per request (stateless transport). */
function buildMcpServer(log: { name: string; args: unknown }[] = callLog): McpServer {
  const server = new McpServer({ name: "e2e-stub-notes", version: "1.0.0" });
  server.registerTool(
    "save_note",
    {
      description: "Save a short note to the user's notebook.",
      inputSchema: { note: z.string().describe("The note text to save.") },
    },
    async ({ note }) => {
      log.push({ name: "save_note", args: { note } });
      return { content: [{ type: "text", text: `note saved: ${note}` }] };
    },
  );
  return server;
}

/** RFC 9728 challenge for the OAuth-protected endpoint. */
const OAUTH_PRM_URL = `http://127.0.0.1:${PORTS.stubMcp}/.well-known/oauth-protected-resource/mcp-oauth`;

/**
 * The `scope` the 401 challenge names — authoritative for the broker's
 * consent request (MCP authorization: the server is saying what THIS request
 * lacked), and deliberately WIDER than the PRM's `scopes_supported` below so
 * that challenge-over-PRM precedence is a real, observable difference here
 * rather than a distinction the fixture flattens.
 */
const OAUTH_CHALLENGE_SCOPE = "notes.read notes.write";
/** The resource's own advertised list — narrower; the fallback, not the rule. */
const OAUTH_PRM_SCOPES = ["notes.read"];

/**
 * RFC 6750 §3: a request that presented no credentials gets a bare challenge;
 * `error="invalid_token"` is reserved for a token that was presented and
 * rejected. Both carry the RFC 9728 `resource_metadata` pointer (what
 * discovery reads first) and the scope.
 */
function sendUnauthorized(res: ServerResponse, presentedToken: boolean): void {
  const params = [
    `resource_metadata="${OAUTH_PRM_URL}"`,
    `scope="${OAUTH_CHALLENGE_SCOPE}"`,
    ...(presentedToken ? [`error="invalid_token"`] : []),
  ];
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", `Bearer ${params.join(", ")}`);
  sendJson(res, { error: "invalid_token" });
}

/**
 * Validate a bearer against the stub AS. Unreachable AS ⇒ invalid. Reports
 * whether a token was PRESENTED separately from whether it was accepted, so
 * the challenge can follow RFC 6750 (see {@link sendUnauthorized}); the token
 * itself never leaves this function.
 */
async function introspectBearer(
  authorization: string | undefined,
): Promise<{ presented: boolean; valid: boolean }> {
  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
  if (token === undefined) return { presented: false, valid: false };
  return { presented: true, valid: await isActive(token) };
}

async function isActive(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${STUB_AS_URL}/__introspect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { active?: boolean };
    return body.active === true;
  } catch {
    return false;
  }
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
    sendJson(res, {
      calls: callLog,
      oauthCalls: oauthCallLog,
      oauthRequests: oauthRequestLog,
    });
    return;
  }
  // RFC 9728 protected-resource metadata for /mcp-oauth (path-aware
  // well-known — the same URL the 401 challenge points at).
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp-oauth") {
    sendJson(res, {
      resource: STUB_OAUTH_MCP_URL,
      authorization_servers: [STUB_AS_URL],
      scopes_supported: OAUTH_PRM_SCOPES,
    });
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

  // The OAuth-protected MCP endpoint. ONE auth gate, before any transport
  // work, covering every request the way a real OAuth MCP server does:
  //  - the control plane's unauthenticated discovery GET → 401 + the
  //    WWW-Authenticate challenge (the PRM pointer + scope discoverOauth
  //    reads);
  //  - `initialize` / `tools/list` — the HEALTH PROBE's dial and the compiled
  //    agent's connection dial → 401 unless a broker-delivered bearer the AS
  //    says is active rides along. This is what makes post-consent `health:
  //    "ok"` and a populated `tools_cache` mean something (fix plan F1);
  //  - `tools/call` → the same gate (eve surfaces a refusal as a failed tool
  //    call, never a hang; spike finding 34).
  if (url.pathname === "/mcp-oauth") {
    let body: unknown;
    try {
      body = req.method === "POST" ? await readJsonBody(req) : undefined;
    } catch {
      body = undefined;
    }
    const rpcMethod =
      body && typeof body === "object" && "method" in body
        ? ((body as { method?: string }).method ?? "?")
        : "?";
    const { presented, valid } = await introspectBearer(req.headers.authorization);
    oauthRequestLog.push({
      httpMethod: req.method ?? "?",
      rpcMethod,
      authValid: valid,
    });
    console.log(
      `[e2e:stub-mcp] ${req.method} /mcp-oauth ${rpcMethod} authValid=${valid}`,
    );
    if (!valid) {
      sendUnauthorized(res, presented);
      return;
    }
    const server = buildMcpServer(oauthCallLog);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
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
