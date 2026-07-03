import { describe, expect, test } from "bun:test";

import {
  generateMasterKeyBase64,
  parseMasterKey,
  type McpAuthWrite,
} from "@invisible-string/shared";

import {
  decryptMcpAuthConfig,
  mcpAuthShape,
  mcpHeaderEnvName,
  mcpTokenEnvName,
} from "../runtime/agent-env";
import { RuntimeApiError } from "../runtime/errors";
import { encryptMcpAuthConfig } from "./mcp-crypto";

const KEY = parseMasterKey(generateMasterKeyBase64());
const ID = "11111111-1111-4111-8111-111111111111";

describe("encryptMcpAuthConfig / decrypt round-trip", () => {
  test("none clears credentials (null envelope)", () => {
    expect(encryptMcpAuthConfig({ type: "none" }, KEY, ID)).toBeNull();
    expect(decryptMcpAuthConfig(null, KEY, ID)).toBeNull();
    expect(mcpAuthShape(null, KEY, ID)).toEqual({ kind: "none" });
  });

  test("bearer round-trips and its shape is bearer", () => {
    const write: McpAuthWrite = { type: "bearer", values: { token: "sk-secret" } };
    const stored = encryptMcpAuthConfig(write, KEY, ID)!;
    expect(stored).not.toContain("sk-secret"); // encrypted at rest
    const config = decryptMcpAuthConfig(stored, KEY, ID);
    expect(config).toMatchObject({ type: "bearer", token: "sk-secret" });
    expect(mcpAuthShape(stored, KEY, ID)).toEqual({ kind: "bearer" });
  });

  test("headers round-trip and expose only header NAMES in the shape", () => {
    const write: McpAuthWrite = {
      type: "headers",
      values: { "X-Api-Key": "abc", Authorization: "Bearer z" },
    };
    const stored = encryptMcpAuthConfig(write, KEY, ID)!;
    expect(stored).not.toContain("abc");
    const config = decryptMcpAuthConfig(stored, KEY, ID);
    expect(config).toMatchObject({
      type: "headers",
      headers: { "X-Api-Key": "abc", Authorization: "Bearer z" },
    });
    const shape = mcpAuthShape(stored, KEY, ID);
    expect(shape.kind).toBe("headers");
    expect(shape.kind === "headers" && shape.headerNames.sort()).toEqual([
      "Authorization",
      "X-Api-Key",
    ]);
  });

  test("AAD binding: an envelope moved to another row id fails to decrypt", () => {
    const stored = encryptMcpAuthConfig(
      { type: "bearer", values: { token: "t" } },
      KEY,
      ID,
    )!;
    expect(() =>
      decryptMcpAuthConfig(stored, KEY, "22222222-2222-4222-8222-222222222222"),
    ).toThrow(RuntimeApiError);
  });
});

describe("env var naming is deterministic + slug-consistent", () => {
  test("token env var matches the compiler's connectionTokenEnvVar", () => {
    expect(mcpTokenEnvName("Linear Prod")).toBe("MCP_LINEAR_PROD_TOKEN");
  });

  test("header env var is stable and header-namespaced", () => {
    expect(mcpHeaderEnvName("Linear", "X-Api-Key")).toBe("MCP_LINEAR_HEADER_X_API_KEY");
    expect(mcpHeaderEnvName("Linear", "Authorization")).toBe(
      "MCP_LINEAR_HEADER_AUTHORIZATION",
    );
    // Idempotent for the same inputs.
    expect(mcpHeaderEnvName("docs api", "X-Key")).toBe(
      mcpHeaderEnvName("docs api", "X-Key"),
    );
  });
});
