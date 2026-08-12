import { describe, expect, test } from "bun:test";

import {
  EMPTY_TOOL_DIRECTORY_INDEX,
  TOOL_RESULT_SUMMARY_MAX_CHARS,
  agentVersionToolDirectorySchema,
  getAgentVersionToolsResponseSchema,
  humanizeToolName,
  indexToolDirectory,
  parseQualifiedToolName,
  resolveToolDisplay,
  splitQualifiedToolName,
  summarizeToolResult,
  type AgentVersionToolDirectory,
} from "./tool-display";

const UUID = "11111111-2222-4333-8444-555555555555";

const directory: AgentVersionToolDirectory = {
  agentVersionId: UUID,
  connections: [
    {
      slug: "linear",
      connectionId: "cn_a1b2c3d4e5f6g7h8",
      connectionName: "Linear",
      tools: [
        {
          name: "create_issue",
          description: "Create an issue in a team's backlog.",
          params: ["team", "title"],
        },
        { name: "list_issues", description: "", params: [] },
      ],
    },
    {
      slug: "github-actions",
      connectionId: "cn_z9y8x7w6v5u4t3s2",
      connectionName: "GitHub Actions",
      tools: [],
    },
  ],
};

describe("qualified tool names", () => {
  test("splits on the first separator, keeping underscores in the tool name", () => {
    expect(splitQualifiedToolName("linear__create_issue")).toEqual({
      connectionSlug: "linear",
      toolName: "create_issue",
    });
    // A tool name may itself contain the separator; the slug grammar cannot,
    // so the FIRST `__` is always the boundary.
    expect(splitQualifiedToolName("linear__weird__tool")).toEqual({
      connectionSlug: "linear",
      toolName: "weird__tool",
    });
  });

  test("an unprefixed builtin has no slug", () => {
    expect(splitQualifiedToolName("ask_question")).toEqual({
      connectionSlug: null,
      toolName: "ask_question",
    });
  });

  test("a half-formed prefix is treated as a builtin, never half-parsed", () => {
    expect(splitQualifiedToolName("__leading")).toEqual({
      connectionSlug: null,
      toolName: "__leading",
    });
    expect(splitQualifiedToolName("trailing__")).toEqual({
      connectionSlug: null,
      toolName: "trailing__",
    });
  });

  test("humanizes snake, kebab, camel and acronym shapes", () => {
    expect(humanizeToolName("create_issue")).toBe("Create issue");
    expect(humanizeToolName("list-repos")).toBe("List repos");
    expect(humanizeToolName("searchIssues")).toBe("Search issues");
    expect(humanizeToolName("getHTTPStatus")).toBe("Get HTTP status");
    expect(humanizeToolName("read")).toBe("Read");
    // Nothing to humanize → the original, never a blank label.
    expect(humanizeToolName("__")).toBe("__");
  });

  test("parseQualifiedToolName combines both halves", () => {
    expect(parseQualifiedToolName("linear__create_issue")).toEqual({
      connectionSlug: "linear",
      toolName: "create_issue",
      label: "Create issue",
    });
  });
});

describe("directory schema", () => {
  test("parses a projected directory and its response envelope", () => {
    expect(agentVersionToolDirectorySchema.safeParse(directory).success).toBe(true);
    expect(
      getAgentVersionToolsResponseSchema.safeParse({ directory }).success,
    ).toBe(true);
    // A connection with no display name is a server bug, not an empty label.
    expect(
      agentVersionToolDirectorySchema.safeParse({
        agentVersionId: UUID,
        connections: [
          { slug: "linear", connectionId: UUID, connectionName: "", tools: [] },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("resolveToolDisplay", () => {
  const index = indexToolDirectory(directory);

  test("resolves connection name and probe-cached description", () => {
    const display = resolveToolDisplay(
      "linear__create_issue",
      index,
      "Created ENG-42",
    );
    expect(display).toEqual({
      qualifiedName: "linear__create_issue",
      connectionSlug: "linear",
      connectionName: "Linear",
      toolName: "create_issue",
      label: "Create issue",
      description: "Create an issue in a team's backlog.",
      resultSummary: "Created ENG-42",
    });
  });

  test("an empty cached description reads as absent", () => {
    expect(resolveToolDisplay("linear__list_issues", index).description).toBeNull();
  });

  test("a builtin resolves with no connection at all", () => {
    const display = resolveToolDisplay("ask_question", index);
    expect(display.connectionSlug).toBeNull();
    expect(display.connectionName).toBeNull();
    expect(display.label).toBe("Ask question");
  });

  test("an unknown slug keeps the slug but has no display name", () => {
    const display = resolveToolDisplay("notion__append_block", index);
    expect(display.connectionSlug).toBe("notion");
    expect(display.connectionName).toBeNull();
    expect(display.label).toBe("Append block");
    expect(display.description).toBeNull();
  });

  test("a known connection with no probed tools still names the connection", () => {
    const display = resolveToolDisplay("github-actions__rerun_job", index);
    expect(display.connectionName).toBe("GitHub Actions");
    expect(display.description).toBeNull();
  });

  test("degrades cleanly with no directory loaded", () => {
    const display = resolveToolDisplay("linear__create_issue");
    expect(display.connectionName).toBeNull();
    expect(display.label).toBe("Create issue");
    expect(indexToolDirectory(null)).toBe(EMPTY_TOOL_DIRECTORY_INDEX);
    expect(indexToolDirectory(undefined)).toBe(EMPTY_TOOL_DIRECTORY_INDEX);
  });
});

describe("summarizeToolResult", () => {
  test("prefers the MCP content envelope's text parts", () => {
    expect(
      summarizeToolResult({
        content: [
          { type: "text", text: "Created issue ENG-42\nin Engineering" },
          { type: "text", text: "" },
        ],
      }),
    ).toBe("Created issue ENG-42 in Engineering");
  });

  test("a content envelope with no text falls back to a count", () => {
    expect(
      summarizeToolResult({ content: [{ type: "image", data: "…" }] }),
    ).toBe("1 attachment");
  });

  test("strings, scalars and short scalar lists read verbatim", () => {
    expect(summarizeToolResult("  done   now ")).toBe("done now");
    expect(summarizeToolResult(7)).toBe("7");
    expect(summarizeToolResult(false)).toBe("false");
    expect(summarizeToolResult(["a", "b"])).toBe("a, b");
  });

  test("collections degrade to counts, never truncated JSON", () => {
    expect(summarizeToolResult([])).toBe("No results");
    expect(summarizeToolResult([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe("3 items");
    expect(summarizeToolResult({ a: 1, b: 2 })).toBe("2 fields");
    expect(summarizeToolResult({ a: 1 })).toBe("1 field");
  });

  test("picks a human-meaningful field when one exists", () => {
    expect(summarizeToolResult({ id: "x", title: "Weekly report" })).toBe(
      "Weekly report",
    );
    expect(summarizeToolResult({ url: "https://example.com/1" })).toBe(
      "https://example.com/1",
    );
  });

  test("clamps to the summary budget", () => {
    const long = "x".repeat(TOOL_RESULT_SUMMARY_MAX_CHARS + 50);
    const summary = summarizeToolResult(long);
    expect(summary).toHaveLength(TOOL_RESULT_SUMMARY_MAX_CHARS + 1);
    expect(summary?.endsWith("…")).toBe(true);
  });

  test("nothing to say reads as null, never as an empty summary", () => {
    expect(summarizeToolResult(null)).toBeNull();
    expect(summarizeToolResult(undefined)).toBeNull();
    expect(summarizeToolResult("   ")).toBeNull();
    expect(summarizeToolResult({})).toBeNull();
  });
});
