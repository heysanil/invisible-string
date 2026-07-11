import { describe, expect, test } from "bun:test";

import { compile, RUNTIME_VERSIONS, type CompileDeps } from "@invisible-string/compiler";
import { agentDefinitionSchema, type AgentDefinition } from "@invisible-string/shared";

import { compileAgent } from "./compiler-adapter";
import type { CompileConnection, CompileRequest } from "./compiler-contract";
import { BUILD_ENV_EPOCH } from "./steps";

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function baseRequest(connection: CompileConnection): CompileRequest {
  const definition: AgentDefinition = agentDefinitionSchema.parse({
    persona: `Use @${slug(connection.name)} to look things up.`,
    model: { preset: "balanced", reasoning: "medium" },
    context: { mcpConnectionIds: [connection.id], skillIds: [] },
  });
  return {
    definition,
    model: {
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      presetSlug: "balanced",
    },
    connections: [connection],
    skills: [],
    workspaceSlug: "acme",
    agentSlug: "lookup",
  };
}

describe("compileAgent — MCP auth wiring", () => {
  test("bearer auth reads the token env var (adapter ↔ codegen agree)", () => {
    const result = compileAgent(
      baseRequest({
        id: "7d3f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6",
        name: "Linear",
        description: "Issues",
        url: "https://mcp.linear.app/mcp",
        envTokenVar: "MCP_LINEAR_TOKEN",
        authHeaders: null,
        toolAllow: null,
        toolBlock: null,
        approvalPolicy: null,
      }),
    );
    const file = result.files.get("agent/connections/linear.ts");
    expect(file).toBeDefined();
    expect(file!).toContain('requireEnv("MCP_LINEAR_TOKEN")');
  });

  test("header auth reads each header value from its injected env var", () => {
    const result = compileAgent(
      baseRequest({
        id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
        name: "Docs API",
        description: "Internal docs",
        url: "https://docs.example.com/mcp",
        envTokenVar: null,
        authHeaders: [{ header: "X-Api-Key", envVar: "MCP_DOCS_API_HEADER_X_API_KEY" }],
        toolAllow: null,
        toolBlock: null,
        approvalPolicy: null,
      }),
    );
    const file = result.files.get("agent/connections/docs-api.ts");
    expect(file).toBeDefined();
    // Header NAME is a literal; its VALUE comes from the injected env var.
    expect(file!).toContain('"X-Api-Key": requireEnv("MCP_DOCS_API_HEADER_X_API_KEY")');
    // No secret value is ever present in generated code.
    expect(file!).not.toContain("Bearer");
  });
});

describe("compileAgent — build-env epoch in the content hash", () => {
  const connection: CompileConnection = {
    id: "7d3f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6",
    name: "Linear",
    description: "Issues",
    url: "https://mcp.linear.app/mcp",
    envTokenVar: "MCP_LINEAR_TOKEN",
    authHeaders: null,
    toolAllow: null,
    toolBlock: null,
    approvalPolicy: null,
  };

  function rawDeps(request: CompileRequest): Omit<CompileDeps, "buildEnvEpoch"> {
    return {
      versions: RUNTIME_VERSIONS,
      resolvedModel: {
        provider: request.model.provider,
        modelId: request.model.modelId,
      },
      workspaceSlug: request.workspaceSlug,
      agentSlug: request.agentSlug,
      connections: [
        {
          id: connection.id,
          slug: "linear",
          url: connection.url!,
          description: connection.description!,
          auth: { kind: "bearerToken" },
          tools: undefined,
          approval: { mode: "never" },
        },
      ],
      skills: [],
    };
  }

  test("BUILD_ENV_EPOCH re-keys the content hash (regression: the eve-build routing placeholder changed artifact bytes without changing the hash — poisoned artifacts kept cache-hitting)", () => {
    const request = baseRequest(connection);
    const adapted = compileAgent(request);
    const withoutEpoch = compile(request.definition, rawDeps(request));
    const withEpoch = compile(request.definition, {
      ...rawDeps(request),
      buildEnvEpoch: BUILD_ENV_EPOCH,
    });
    expect(adapted.hash).not.toBe(withoutEpoch.hash);
    expect(adapted.hash).toBe(withEpoch.hash);
    const bumped = compile(request.definition, {
      ...rawDeps(request),
      buildEnvEpoch: BUILD_ENV_EPOCH + 1,
    });
    expect(bumped.hash).not.toBe(adapted.hash);
    // Still a well-formed sha256 hex (worldNameForHash / artifact keys rely on it).
    expect(adapted.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the baked platform-JWT audience is bound to the SAME hash the control plane keys by (an outward hash the compiled agent doesn't know would 401 every platform token)", () => {
    const adapted = compileAgent(baseRequest(connection));
    const authLib = adapted.files.get("agent/lib/platform-auth.ts");
    expect(authLib).toBeDefined();
    expect(authLib!).toContain(adapted.hash);
  });
});
