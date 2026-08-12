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
    // No explicit effort — the agent INHERITS what the control plane resolved
    // (an explicit one that disagreed with `model.reasoning` below would trip
    // the compiler's MODEL_MISMATCH guard).
    model: { preset: "balanced" },
    context: { mcpConnectionIds: [connection.id], skillIds: [] },
  });
  return {
    definition,
    model: {
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      reasoning: "max",
      presetSlug: "balanced",
    },
    connections: [connection],
    skills: [],
    workspaceSlug: "acme",
    // Identity (hashed) vs. display slug (emitted) — spec D1.
    agentId: "b2000000-0000-4000-8000-00000000000a",
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

  test("oauth rows map to broker-delivered getToken by connection id (spec §6)", () => {
    const oauthRow: CompileConnection = {
      id: "cn_ab12cd34ef56gh78",
      name: "Linear",
      description: "Issues",
      url: "https://mcp.linear.app/mcp",
      envTokenVar: null,
      authHeaders: null,
      oauth: true,
      toolAllow: null,
      toolBlock: null,
      approvalPolicy: null,
    };
    const result = compileAgent(baseRequest(oauthRow));
    const file = result.files.get("agent/connections/linear.ts");
    expect(file).toBeDefined();
    expect(file!).toContain(
      'platformConnectionToken("cn_ab12cd34ef56gh78")',
    );
    // No static-credential env reads on the oauth branch…
    expect(file!).not.toContain("requireEnv");
    // …and the platform-token lib rides along.
    expect(result.files.get("agent/lib/platform-token.ts")).toContain(
      'requireEnv("PLATFORM_API_URL")',
    );

    // The auth SHAPE is hashed (spec §8): the same row with bearer auth
    // must produce a different content hash.
    const bearer = compileAgent(
      baseRequest({
        ...oauthRow,
        oauth: false,
        envTokenVar: "MCP_LINEAR_TOKEN",
      }),
    );
    expect(bearer.hash).not.toBe(result.hash);
  });

  test("agentId reaches the hash — same name, same definition, different agent", () => {
    // The adapter is the only thing standing between `agents.id` and the
    // hash; if it dropped the field, two agents a user named the same thing
    // would compile to one artifact, one JWT audience, and one
    // `ag_v_<hash12>` world database with two writers (spec D1). The API
    // used to be protected from this only by a unique index on
    // (organization_id, name), which this change drops.
    const row: CompileConnection = {
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
    const first = compileAgent(baseRequest(row));
    const twin = compileAgent({
      ...baseRequest(row),
      agentId: "b2000000-0000-4000-8000-00000000000b",
    });
    expect(twin.hash).not.toBe(first.hash);
    // …and it is identity only: nothing emits it.
    for (const content of twin.files.values()) {
      expect(content).not.toInclude("b2000000-0000-4000-8000-00000000000b");
    }
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
        reasoning: request.model.reasoning,
      },
      workspaceSlug: request.workspaceSlug,
      agentId: request.agentId,
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

describe("compileAgent — resolved reasoning effort", () => {
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

  test("the RESOLVED effort (not the definition's, which may be inherited) reaches the generated model", () => {
    const request = baseRequest(connection);
    // The definition sets no effort at all; only the resolved model carries it.
    expect(request.definition.model.reasoning).toBeUndefined();
    const agentTs = compileAgent(request).files.get("agent/agent.ts");
    expect(agentTs).toBeDefined();
    expect(agentTs!).toContain('extraBody: { reasoning: { effort: "max" } }');
  });

  test("`provider-default` emits no reasoning field at all", () => {
    const base = baseRequest(connection);
    const agentTs = compileAgent({
      ...base,
      model: { ...base.model, reasoning: "provider-default" },
    }).files.get("agent/agent.ts");
    expect(agentTs!).not.toContain("reasoning:");
  });

  test("the effort re-keys the content hash — inheritance from two presets with different efforts must not share an artifact", () => {
    const base = baseRequest(connection);
    const max = compileAgent(base);
    const low = compileAgent({ ...base, model: { ...base.model, reasoning: "low" } });
    expect(low.hash).not.toBe(max.hash);
  });
});
