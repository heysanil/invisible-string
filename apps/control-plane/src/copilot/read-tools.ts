/**
 * Workflow-surface READ tools — searchConnectionTools / getConnectionTool —
 * executed INLINE by the session loop (pipelines redesign): pure lookups over
 * the turn's inventory (the probe's cached `tools/list`, never a live MCP
 * call), no proposal, no park. Progress rides the existing `step` frames;
 * the full ranked text goes back to the model as an ordinary tool result.
 *
 * These exist to make the prompt's hard rule enforceable: tool DETAIL
 * (descriptions, params, cached input schemas) stays out of the system
 * prompt — the inventory carries only a capped name index — and the model
 * fetches what it needs per turn instead of guessing.
 */
import {
  workflowCopilotReadParamSchemas,
  type GetConnectionToolParams,
  type SearchConnectionToolsParams,
  type WorkflowCopilotReadTool,
} from "@invisible-string/shared";

import type { InventoryConnection, WorkspaceInventory } from "./inventory";

/** Ranked matches returned per search — enough to pick from, cheap to read. */
export const SEARCH_RESULT_CAP = 10;

/** Clamp on a rendered cached input schema (JSON, pretty-printed). */
export const INPUT_SCHEMA_RENDER_CAP = 4_000;

export type ReadToolOutcome =
  | { ok: true; result: string; preview: string }
  | { ok: false; message: string };

export function isWorkflowReadTool(
  name: string,
): name is WorkflowCopilotReadTool {
  return name in workflowCopilotReadParamSchemas;
}

/**
 * Execute one read tool against the turn's inventory. Invalid params and
 * unknown ids come back `ok: false` — the session wraps the message in the
 * same model-facing tool-error scaffolding as an invalid mutation, so the
 * model self-corrects.
 */
export function executeReadTool(
  tool: WorkflowCopilotReadTool,
  input: unknown,
  inventory: WorkspaceInventory,
): ReadToolOutcome {
  const parsed = workflowCopilotReadParamSchemas[tool].safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `invalid ${tool} params — ${issues}` };
  }
  return tool === "searchConnectionTools"
    ? searchConnectionTools(parsed.data as SearchConnectionToolsParams, inventory)
    : getConnectionTool(parsed.data as GetConnectionToolParams, inventory);
}

/** Flatten workspace/registry-controlled text so it cannot forge result lines. */
function flat(text: string, maxLength = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1)}…`
    : collapsed;
}

function describeEnabledConnections(inventory: WorkspaceInventory): string {
  const lines = inventory.connections
    .filter((c) => c.enabled)
    .map((c) => `${c.id} (${c.name})`)
    .join(", ");
  return lines || "(none)";
}

// ── searchConnectionTools ────────────────────────────────────────────────────

interface ToolMatch {
  connection: InventoryConnection;
  tool: InventoryConnection["cachedTools"][number];
  score: number;
}

/**
 * Rank cached tools against the query: exact name match ≫ name substring ≫
 * per-token hits in name/description. An empty query browses (cache order),
 * which with `connectionId` is "list this connection's tools".
 */
function searchConnectionTools(
  params: SearchConnectionToolsParams,
  inventory: WorkspaceInventory,
): ReadToolOutcome {
  let pool = inventory.connections.filter((c) => c.enabled);
  if (params.connectionId !== undefined) {
    const connection = inventory.connections.find(
      (c) => c.id === params.connectionId,
    );
    if (!connection) {
      return {
        ok: false,
        message: `connection id "${params.connectionId}" does not exist in this workspace — known connections: ${describeEnabledConnections(inventory)}`,
      };
    }
    if (!connection.enabled) {
      return {
        ok: false,
        message: `connection "${connection.name}" is disabled — enabled connections: ${describeEnabledConnections(inventory)}`,
      };
    }
    pool = [connection];
  }

  const query = params.query.trim().toLowerCase();
  const tokens = query.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  const matches: ToolMatch[] = [];
  for (const connection of pool) {
    for (const tool of connection.cachedTools) {
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = 0;
      if (query === "") {
        score = 1; // browse: everything matches, cache order preserved
      } else {
        if (name === query) score += 100;
        else if (name.includes(query)) score += 60;
        for (const token of tokens) {
          if (name.includes(token)) score += 10;
          if (description.includes(token)) score += 4;
        }
      }
      if (score > 0) matches.push({ connection, tool, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);

  const shown = matches.slice(0, SEARCH_RESULT_CAP);
  const lines = shown.map(({ connection, tool }) => {
    const params_ = tool.params.length > 0 ? ` params=[${tool.params.join(", ")}]` : "";
    const description = tool.description ? ` — ${flat(tool.description)}` : "";
    return `- connection=${connection.id} (${connection.name}) tool=${tool.name}${params_}${description}`;
  });

  // A connection with an empty cache is silent above — say so, or the model
  // reads "no results" as "this connection has no tools".
  const unsearchable = pool
    .filter((c) => c.cachedTools.length === 0)
    .map(
      (c) =>
        `note: connection ${c.id} (${c.name}) has no cached tool list (health=${c.health}) — its tools cannot be searched until a probe succeeds`,
    );

  const parts: string[] = [];
  if (shown.length === 0) {
    parts.push(
      query === ""
        ? "No cached tools found."
        : `No cached tools match "${params.query.trim()}". Try different words, or an empty query with a connectionId to browse.`,
    );
  } else {
    parts.push(
      `${shown.length} of ${matches.length} matching tool(s):`,
      ...lines,
    );
    if (matches.length > shown.length) {
      parts.push(`…and ${matches.length - shown.length} more — refine the query.`);
    }
    parts.push(
      "Call getConnectionTool for a tool's full description and input schema before shaping args.",
    );
  }
  parts.push(...unsearchable);

  const preview =
    query === ""
      ? `${matches.length} tool(s)${pool.length === 1 && pool[0] ? ` on ${pool[0].name}` : ""}`
      : `${matches.length} match(es) for "${flat(params.query.trim(), 60)}"`;
  return { ok: true, result: parts.join("\n"), preview };
}

// ── getConnectionTool ────────────────────────────────────────────────────────

function getConnectionTool(
  params: GetConnectionToolParams,
  inventory: WorkspaceInventory,
): ReadToolOutcome {
  const connection = inventory.connections.find(
    (c) => c.id === params.connectionId,
  );
  if (!connection) {
    return {
      ok: false,
      message: `connection id "${params.connectionId}" does not exist in this workspace — known connections: ${describeEnabledConnections(inventory)}`,
    };
  }
  if (connection.cachedTools.length === 0) {
    return {
      ok: false,
      message: `connection "${connection.name}" has no cached tool list (health=${connection.health}) — its tools cannot be inspected until a probe succeeds`,
    };
  }
  const tool = connection.cachedTools.find((t) => t.name === params.toolName);
  if (!tool) {
    const names = connection.cachedTools
      .slice(0, 40)
      .map((t) => t.name)
      .join(", ");
    return {
      ok: false,
      message: `tool "${params.toolName}" is not in connection "${connection.name}"'s cached tool list — cached tools: ${names}${connection.cachedTools.length > 40 ? ", …" : ""}`,
    };
  }

  const lines = [
    `tool=${tool.name} connection=${connection.id} (${connection.name})`,
    `description: ${flat(tool.description, 500) || "(none)"}`,
    `params: ${tool.params.join(", ") || "(none listed)"}`,
  ];
  if (tool.inputSchema !== undefined) {
    let rendered = JSON.stringify(tool.inputSchema, null, 2);
    if (rendered.length > INPUT_SCHEMA_RENDER_CAP) {
      rendered = `${rendered.slice(0, INPUT_SCHEMA_RENDER_CAP)}\n… (schema truncated)`;
    }
    lines.push(`input schema (JSON Schema):\n${rendered}`);
  } else {
    lines.push(
      "no cached input schema — the parameter names above are all that is known; keep args minimal and obvious.",
    );
  }
  return {
    ok: true,
    result: lines.join("\n"),
    preview: `${tool.name} on ${connection.name}`,
  };
}
