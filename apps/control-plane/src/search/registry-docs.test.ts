/**
 * Registry entry → search document mapping (connectors redesign spec §5).
 * Pure-function suite — no services, runs in the default unit lane.
 */
import { expect, test } from "bun:test";

import { registryDocId, syncEntryToAction } from "./registry-docs";

// Build entries inline, mirroring real /v0.1/servers rows.
const entry = (over: object, meta: object = {}) => ({
  server: {
    name: "app.linear/linear",
    description: "Linear MCP",
    version: "1.0.1",
    remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }],
    ...over,
  },
  _meta: {
    "io.modelcontextprotocol.registry/official": {
      status: "active",
      isLatest: true,
      ...meta,
    },
  },
});

test("id is unpadded base64url", () => {
  expect(registryDocId("app.linear/linear")).not.toContain("=");
  expect(
    Buffer.from(registryDocId("app.linear/linear"), "base64url").toString(),
  ).toBe("app.linear/linear");
});

test("latest active server with remotes upserts, verified for non-io.github namespaces", () => {
  const a = syncEntryToAction(entry({}));
  expect(a.kind).toBe("upsert");
  if (a.kind === "upsert") expect(a.doc.verified).toBe(true);
});

test("io.github.* namespace is unverified", () => {
  const a = syncEntryToAction(entry({ name: "io.github.someone/fork" }));
  expect(a.kind).toBe("upsert");
  if (a.kind === "upsert") expect(a.doc.verified).toBe(false);
});

test("non-latest skips; deleted deletes; remote-less deletes", () => {
  expect(syncEntryToAction(entry({}, { isLatest: false })).kind).toBe("skip");
  expect(syncEntryToAction(entry({}, { status: "deleted" })).kind).toBe(
    "delete",
  );
  expect(syncEntryToAction(entry({ remotes: [] })).kind).toBe("delete");
});
