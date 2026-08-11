/**
 * Probe-client suite against an IN-PROCESS, protocol-correct MCP fixture —
 * the official SDK's `McpServer` + `StreamableHTTPServerTransport` (stateless,
 * a fresh pair per request) on a `node:http` server bound to an ephemeral
 * 127.0.0.1 port, mirroring `e2e/scripts/stub-mcp.ts`. No external services:
 * this suite runs in the plain unit lane. Every probe goes through the real
 * guarded egress fetch (`allowPrivate: true` — the fixture is loopback http).
 */
import { describe, expect, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { createGuardedFetch } from "../net/guarded-fetch";
import { probeMcpServer } from "./mcp-probe";

const guardedFetch = createGuardedFetch({ allowPrivate: true });

/** Long enough to prove the 500-char description truncation. */
const LONG_DESCRIPTION = `Save a short note to the user's notebook. ${"x".repeat(600)}`;

/** A fresh MCP server per request (stateless transport), like the e2e stub. */
function buildFixtureMcpServer(toolCount: number): McpServer {
  const server = new McpServer({ name: "probe-fixture-notes", version: "1.0.0" });
  server.registerTool(
    "save_note",
    {
      description: LONG_DESCRIPTION,
      inputSchema: { note: z.string().describe("The note text to save.") },
    },
    async ({ note }) => ({
      content: [{ type: "text", text: `note saved: ${note}` }],
    }),
  );
  for (let i = 1; i < toolCount; i++) {
    server.registerTool(
      `filler_${i}`,
      { description: `Filler tool ${i}.`, inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
  }
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

interface Fixture {
  url: string;
  close(): Promise<void>;
}

/** node:http server on an ephemeral loopback port with tracked sockets. */
async function serveFixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<Fixture> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function mcpHandler(toolCount = 1) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const server = buildFixtureMcpServer(toolCount);
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
    await transport.handleRequest(req, res, body);
  };
}

function unauthorizedHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("www-authenticate", 'Bearer realm="mcp"');
  res.end("unauthorized");
}

describe("probeMcpServer", () => {
  test("healthy server → ok with the tool list trimmed", async () => {
    const fixture = await serveFixture(mcpHandler());
    try {
      const outcome = await probeMcpServer({
        url: fixture.url,
        transport: "streamable-http",
        headers: {},
        hasCredentials: false,
        fetchImpl: guardedFetch,
      });
      expect(outcome.health).toBe("ok");
      expect(outcome.error).toBeNull();
      expect(outcome.tools).toHaveLength(1);
      const tool = outcome.tools![0]!;
      expect(tool.name).toBe("save_note");
      expect(tool.params).toEqual(["note"]);
      // Description truncated at 500 chars, keeping the head.
      expect(tool.description.length).toBe(500);
      expect(
        tool.description.startsWith("Save a short note to the user's notebook."),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("tool list is capped at 200 entries", async () => {
    const fixture = await serveFixture(mcpHandler(210));
    try {
      const outcome = await probeMcpServer({
        url: fixture.url,
        transport: "streamable-http",
        headers: {},
        hasCredentials: false,
        fetchImpl: guardedFetch,
      });
      expect(outcome.health).toBe("ok");
      expect(outcome.tools).toHaveLength(200);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("401 without credentials → auth_required", async () => {
    const fixture = await serveFixture(unauthorizedHandler);
    try {
      const outcome = await probeMcpServer({
        url: fixture.url,
        transport: "streamable-http",
        headers: {},
        hasCredentials: false,
        fetchImpl: guardedFetch,
      });
      expect(outcome.health).toBe("auth_required");
      expect(outcome.tools).toBeNull();
      expect(outcome.error).toBeTruthy();
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("401 with credentials present → auth_error, error never leaks the secret", async () => {
    const fixture = await serveFixture(unauthorizedHandler);
    try {
      const outcome = await probeMcpServer({
        url: fixture.url,
        transport: "streamable-http",
        headers: { Authorization: "Bearer super-secret-token" },
        hasCredentials: true,
        fetchImpl: guardedFetch,
      });
      expect(outcome.health).toBe("auth_error");
      expect(outcome.tools).toBeNull();
      expect(outcome.error).toBeTruthy();
      expect(outcome.error).not.toContain("super-secret-token");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("closed port → unreachable", async () => {
    const fixture = await serveFixture(unauthorizedHandler);
    await fixture.close(); // the port now refuses connections
    const outcome = await probeMcpServer({
      url: fixture.url,
      transport: "streamable-http",
      headers: {},
      hasCredentials: false,
      fetchImpl: guardedFetch,
    });
    expect(outcome.health).toBe("unreachable");
    expect(outcome.tools).toBeNull();
    expect(outcome.error).toBeTruthy();
  }, 15_000);

  test("hung server → unreachable via the probe timeout", async () => {
    const fixture = await serveFixture(() => {
      // Accept the request and never respond.
    });
    try {
      const outcome = await probeMcpServer({
        url: fixture.url,
        transport: "streamable-http",
        headers: {},
        hasCredentials: false,
        fetchImpl: guardedFetch,
        timeoutMs: 500,
      });
      expect(outcome.health).toBe("unreachable");
      expect(outcome.tools).toBeNull();
      expect(outcome.error).toMatch(/time/i);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
