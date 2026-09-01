/**
 * Pipeline MCP caller against the probe suite's in-process, protocol-correct
 * fixture (SDK `McpServer` + stateless `StreamableHTTPServerTransport` on a
 * loopback `node:http` server) — plain unit lane, no external services, every
 * call through the real guarded egress fetch (`allowPrivate: true`).
 *
 * The point of the suite is the CLASSIFICATION table: the runner's retry
 * policy keys off `errorClass`/`retryable`, so each class is pinned — and the
 * retryable set is exactly the plan's (`unreachable`/`timeout`/429/5xx).
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
import { callMcpTool, type McpToolCallInput } from "./mcp-call";

const guardedFetch = createGuardedFetch({ allowPrivate: true });

/** A fresh MCP server per request (stateless transport), like the probe suite. */
function buildFixtureMcpServer(): McpServer {
  const server = new McpServer({ name: "call-fixture-notes", version: "1.0.0" });
  server.registerTool(
    "save_note",
    {
      description: "Save a short note.",
      inputSchema: { note: z.string() },
    },
    async ({ note }) => ({
      content: [{ type: "text", text: `note saved: ${note}` }],
    }),
  );
  server.registerTool(
    "lookup",
    {
      description: "Structured answer.",
      inputSchema: { q: z.string() },
      outputSchema: { answer: z.string() },
    },
    async ({ q }) => ({
      content: [{ type: "text", text: `answer for ${q}` }],
      structuredContent: { answer: `answer for ${q}` },
    }),
  );
  server.registerTool(
    "always_fails",
    { description: "Reports a tool-level error.", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: "downstream exploded" }],
      isError: true,
    }),
  );
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

function mcpHandler() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const server = buildFixtureMcpServer();
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

function statusHandler(status: number) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.statusCode = status;
    if (status === 401) res.setHeader("www-authenticate", 'Bearer realm="mcp"');
    res.end(`status ${status}`);
  };
}

function callInput(
  url: string,
  overrides: Partial<McpToolCallInput> = {},
): McpToolCallInput {
  return {
    url,
    transport: "streamable-http",
    headers: {},
    hasCredentials: false,
    fetchImpl: guardedFetch,
    toolName: "save_note",
    args: { note: "hello" },
    ...overrides,
  };
}

describe("callMcpTool", () => {
  test("text tool → ok with the text parts, no error flag", async () => {
    const fixture = await serveFixture(mcpHandler());
    try {
      const outcome = await callMcpTool(callInput(fixture.url));
      expect(outcome).toEqual({
        kind: "ok",
        isError: false,
        structuredContent: undefined,
        textParts: ["note saved: hello"],
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("structured tool → structuredContent surfaces", async () => {
    const fixture = await serveFixture(mcpHandler());
    try {
      const outcome = await callMcpTool(
        callInput(fixture.url, { toolName: "lookup", args: { q: "life" } }),
      );
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("unreachable");
      expect(outcome.isError).toBe(false);
      expect(outcome.structuredContent).toEqual({ answer: "answer for life" });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("tool-level failure → ok with isError (a TOOL error, not a transport one)", async () => {
    const fixture = await serveFixture(mcpHandler());
    try {
      const outcome = await callMcpTool(
        callInput(fixture.url, { toolName: "always_fails", args: {} }),
      );
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("unreachable");
      expect(outcome.isError).toBe(true);
      expect(outcome.textParts).toEqual(["downstream exploded"]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("unknown tool → tool_not_found, never retryable", async () => {
    const fixture = await serveFixture(mcpHandler());
    try {
      const outcome = await callMcpTool(
        callInput(fixture.url, { toolName: "nope", args: {} }),
      );
      expect(outcome).toMatchObject({
        kind: "error",
        errorClass: "tool_not_found",
        retryable: false,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("server-rejected arguments → invalid_args, never retryable", async () => {
    const fixture = await serveFixture(mcpHandler());
    try {
      // save_note requires a string `note`; the server's own zod rejects this.
      const outcome = await callMcpTool(
        callInput(fixture.url, { args: { note: 42 } }),
      );
      expect(outcome).toMatchObject({
        kind: "error",
        errorClass: "invalid_args",
        retryable: false,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("401 classifies by credential presence, and never leaks the secret", async () => {
    const fixture = await serveFixture(statusHandler(401));
    try {
      const anonymous = await callMcpTool(callInput(fixture.url));
      expect(anonymous).toMatchObject({
        kind: "error",
        errorClass: "auth_required",
        retryable: false,
      });

      const credentialed = await callMcpTool(
        callInput(fixture.url, {
          headers: { Authorization: "Bearer super-secret-token" },
          hasCredentials: true,
        }),
      );
      expect(credentialed).toMatchObject({
        kind: "error",
        errorClass: "auth_error",
        retryable: false,
      });
      if (credentialed.kind !== "error") throw new Error("unreachable");
      expect(credentialed.error).not.toContain("super-secret-token");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("HTTP 429 → rate_limited, retryable", async () => {
    const fixture = await serveFixture(statusHandler(429));
    try {
      const outcome = await callMcpTool(callInput(fixture.url));
      expect(outcome).toMatchObject({
        kind: "error",
        errorClass: "rate_limited",
        retryable: true,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("non-auth HTTP 4xx → endpoint_error, NOT retryable", async () => {
    const fixture = await serveFixture(statusHandler(404));
    try {
      const outcome = await callMcpTool(callInput(fixture.url));
      expect(outcome).toMatchObject({
        kind: "error",
        errorClass: "endpoint_error",
        retryable: false,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("HTTP 500 → server_error, retryable", async () => {
    const fixture = await serveFixture(statusHandler(500));
    try {
      const outcome = await callMcpTool(callInput(fixture.url));
      expect(outcome).toMatchObject({
        kind: "error",
        errorClass: "server_error",
        retryable: true,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("closed port → unreachable, retryable", async () => {
    const fixture = await serveFixture(statusHandler(500));
    await fixture.close(); // the port now refuses connections
    const outcome = await callMcpTool(callInput(fixture.url));
    expect(outcome).toMatchObject({
      kind: "error",
      errorClass: "unreachable",
      retryable: true,
    });
  }, 15_000);

  test("hung server → timeout via the wall-clock deadline, retryable", async () => {
    const fixture = await serveFixture(() => {
      // Accept the request and never respond.
    });
    try {
      const outcome = await callMcpTool(
        callInput(fixture.url, { timeoutMs: 500 }),
      );
      expect(outcome).toMatchObject({
        kind: "error",
        errorClass: "timeout",
        retryable: true,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  test("an already-aborted signal → canceled without dialing", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await callMcpTool(
      callInput("http://127.0.0.1:9/mcp", { signal: controller.signal }),
    );
    expect(outcome).toMatchObject({
      kind: "error",
      errorClass: "canceled",
      retryable: false,
    });
  });
});
