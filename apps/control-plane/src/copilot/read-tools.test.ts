/**
 * Read-tool execution — pure unit coverage for the inventory lookups the
 * session runs inline on the workflow surface (searchConnectionTools /
 * getConnectionTool). Socket behavior (step frames, tool results, no
 * proposals) lives in copilot.test.ts.
 */
import { describe, expect, test } from "bun:test";

import type { WorkspaceInventory } from "./inventory";
import {
  executeReadTool,
  isWorkflowReadTool,
  SEARCH_RESULT_CAP,
} from "./read-tools";

const LINEAR_ID = "cn_linear1234567890";
const NOTES_ID = "cn_notesaaaaaaaaaa1";
const DISABLED_ID = "cn_oldcrm1234567890";
const UNPROBED_ID = "cn_unprobedaaaaaaa1";

const inventory: WorkspaceInventory = {
  connections: [
    {
      id: LINEAR_ID,
      name: "Linear",
      slug: "linear",
      description: "issue tracker",
      enabled: true,
      scope: "workspace",
      health: "ok",
      tools: ["create_issue", "search_issues"],
      toolCount: 2,
      cachedTools: [
        {
          name: "create_issue",
          description: "Create a Linear issue in a team",
          params: ["title", "description", "teamId"],
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
        {
          name: "search_issues",
          description: "Full-text search over Linear issues",
          params: ["query"],
        },
      ],
    },
    {
      id: NOTES_ID,
      name: "Notes",
      slug: "notes",
      description: null,
      enabled: true,
      scope: "workspace",
      health: "ok",
      tools: [],
      toolCount: 20,
      cachedTools: Array.from({ length: 20 }, (_, i) => ({
        name: `note_tool_${i + 1}`,
        description: `notes helper number ${i + 1}`,
        params: ["text"],
      })),
    },
    {
      id: DISABLED_ID,
      name: "Old CRM",
      slug: "old-crm",
      description: null,
      enabled: false,
      scope: "workspace",
      health: "unknown",
      tools: [],
      toolCount: 0,
      cachedTools: [{ name: "crm_export", description: "", params: [] }],
    },
    {
      id: UNPROBED_ID,
      name: "Fresh Server",
      slug: "fresh-server",
      description: null,
      enabled: true,
      scope: "workspace",
      health: "unknown",
      tools: [],
      toolCount: 0,
      cachedTools: [],
    },
  ],
  skills: [],
  agents: [],
  modelPresets: [],
  allowlist: [],
  catalogAvailable: true,
};

describe("isWorkflowReadTool", () => {
  test("recognizes exactly the two read tools", () => {
    expect(isWorkflowReadTool("searchConnectionTools")).toBe(true);
    expect(isWorkflowReadTool("getConnectionTool")).toBe(true);
    expect(isWorkflowReadTool("addStep")).toBe(false);
    expect(isWorkflowReadTool("setPersona")).toBe(false);
  });
});

describe("searchConnectionTools", () => {
  test("ranks an exact name match first and includes connection ids", () => {
    const outcome = executeReadTool(
      "searchConnectionTools",
      { query: "create_issue" },
      inventory,
    );
    if (!outcome.ok) throw new Error(outcome.message);
    const firstLine = outcome.result
      .split("\n")
      .find((line) => line.startsWith("- "));
    expect(firstLine).toContain("tool=create_issue");
    expect(firstLine).toContain(`connection=${LINEAR_ID}`);
    expect(firstLine).toContain("params=[title, description, teamId]");
    expect(outcome.preview).toContain("match");
  });

  test("token matches reach descriptions, results are capped with a marker", () => {
    const outcome = executeReadTool(
      "searchConnectionTools",
      { query: "notes helper" },
      inventory,
    );
    if (!outcome.ok) throw new Error(outcome.message);
    const lines = outcome.result
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(SEARCH_RESULT_CAP);
    expect(outcome.result).toContain("more — refine the query");
  });

  test("an empty query with a connectionId browses that connection", () => {
    const outcome = executeReadTool(
      "searchConnectionTools",
      { query: "", connectionId: LINEAR_ID },
      inventory,
    );
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.result).toContain("tool=create_issue");
    expect(outcome.result).toContain("tool=search_issues");
    expect(outcome.preview).toContain("Linear");
  });

  test("unknown and disabled connection ids bounce with the known roster", () => {
    const unknown = executeReadTool(
      "searchConnectionTools",
      { query: "x", connectionId: "cn_zzzzzzzzzzzzzzzz" },
      inventory,
    );
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toContain("does not exist");
    expect(!unknown.ok && unknown.message).toContain(LINEAR_ID);

    const disabled = executeReadTool(
      "searchConnectionTools",
      { query: "export", connectionId: DISABLED_ID },
      inventory,
    );
    expect(disabled.ok).toBe(false);
    expect(!disabled.ok && disabled.message).toContain("disabled");
  });

  test("a no-match search says so and unprobed connections are called out", () => {
    const outcome = executeReadTool(
      "searchConnectionTools",
      { query: "quantum flux capacitor" },
      inventory,
    );
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.result).toContain("No cached tools match");
    // The unprobed connection is named — "no results" must never read as
    // "this connection has no tools".
    expect(outcome.result).toContain(UNPROBED_ID);
    expect(outcome.result).toContain("no cached tool list");
  });

  test("malformed params come back as a model-facing problem", () => {
    const outcome = executeReadTool(
      "searchConnectionTools",
      { query: 42 },
      inventory,
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("invalid searchConnectionTools params");
  });
});

describe("getConnectionTool", () => {
  test("renders description, params and the cached input schema", () => {
    const outcome = executeReadTool(
      "getConnectionTool",
      { connectionId: LINEAR_ID, toolName: "create_issue" },
      inventory,
    );
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.result).toContain("Create a Linear issue in a team");
    expect(outcome.result).toContain("params: title, description, teamId");
    expect(outcome.result).toContain("input schema (JSON Schema):");
    expect(outcome.result).toContain('"required"');
    expect(outcome.preview).toBe("create_issue on Linear");
  });

  test("a tool without a cached schema says so instead of inventing one", () => {
    const outcome = executeReadTool(
      "getConnectionTool",
      { connectionId: LINEAR_ID, toolName: "search_issues" },
      inventory,
    );
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.result).toContain("no cached input schema");
    expect(outcome.result).not.toContain("input schema (JSON Schema):");
  });

  test("an unknown tool name lists the cached names for self-correction", () => {
    const outcome = executeReadTool(
      "getConnectionTool",
      { connectionId: LINEAR_ID, toolName: "close_issue" },
      inventory,
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("create_issue, search_issues");
  });

  test("an empty cache is an explicit probe-pending error", () => {
    const outcome = executeReadTool(
      "getConnectionTool",
      { connectionId: UNPROBED_ID, toolName: "anything" },
      inventory,
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("no cached tool list");
  });
});
