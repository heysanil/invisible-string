import { describe, expect, test } from "bun:test";

import type { WorkflowDefinition } from "@invisible-string/shared";

import { compileWorkflow } from "./compiler-adapter";
import type { CompileConnection, CompileRequest } from "./compiler-contract";

function baseRequest(connection: CompileConnection): CompileRequest {
  const definition: WorkflowDefinition = {
    trigger: { type: "manual" },
    context: { mcpConnectionIds: [connection.id], skillIds: [] },
    agent: { agentPresetId: "0f8b6c1e-4a6f-4a5e-9b3d-1c2e3f405060" },
    instructions: { markdown: `Use @${slug(connection.name)} to look things up.` },
  };
  return {
    definition,
    model: {
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      reasoning: "medium",
      agentName: "General Purpose",
      basePrompt: "You are helpful.",
    },
    connections: [connection],
    skills: [],
    workspaceSlug: "acme",
    workflowSlug: "lookup",
  };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

describe("compileWorkflow — MCP auth wiring", () => {
  test("bearer auth reads the token env var (adapter ↔ codegen agree)", () => {
    const result = compileWorkflow(
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
    const result = compileWorkflow(
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
