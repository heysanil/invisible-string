/**
 * TanStack Query key factory — the ONLY place query keys are spelled.
 * Hooks and invalidation helpers both read from here, so a key can never
 * drift between the query that caches it and the mutation that invalidates
 * it.
 *
 * Shape: [resource, ...scope segments, kind, ...args]. `all(...)` prefixes
 * exist so one invalidate covers a resource's list AND details.
 */
import type { AgentSessionStatus } from "@invisible-string/shared";

/**
 * Owner of a scoped context resource (MCP connections, skills — spec §9
 * requires BOTH workspace- and user-level).
 */
export type ScopeRef =
  | { scope: "workspace"; workspaceId: string }
  | { scope: "user" };

/** REST base path for a scoped resource. */
export function scopeBasePath(
  ref: ScopeRef,
  resource: "mcp-connections" | "skills",
): string {
  return ref.scope === "user"
    ? `/me/${resource}`
    : `/workspaces/${ref.workspaceId}/${resource}`;
}

function scopeSegments(ref: ScopeRef): readonly string[] {
  return ref.scope === "user" ? ["me"] : ["ws", ref.workspaceId];
}

export interface SessionListFilters {
  /** Restrict to one agent (the agent's chat history). */
  agentId?: string;
  /** Restrict to one workflow (trigger provenance). */
  workflowId?: string;
  status?: AgentSessionStatus;
}

export const queryKeys = {
  workflows: {
    all: (workspaceId: string) => ["workflows", workspaceId] as const,
    list: (workspaceId: string) => ["workflows", workspaceId, "list"] as const,
    detail: (workspaceId: string, workflowId: string) =>
      ["workflows", workspaceId, "detail", workflowId] as const,
  },
  sessions: {
    all: (workspaceId: string) => ["sessions", workspaceId] as const,
    list: (workspaceId: string, filters: SessionListFilters = {}) =>
      [
        "sessions",
        workspaceId,
        "list",
        filters.agentId ?? null,
        filters.workflowId ?? null,
        filters.status ?? null,
      ] as const,
    /** Session detail is fetched by id (`GET /sessions/:id`). */
    detail: (sessionId: string) => ["sessions", "detail", sessionId] as const,
  },
  mcpConnections: {
    all: (ref: ScopeRef) => ["mcp-connections", ...scopeSegments(ref)] as const,
    list: (ref: ScopeRef) =>
      ["mcp-connections", ...scopeSegments(ref), "list"] as const,
    detail: (ref: ScopeRef, connectionId: string) =>
      ["mcp-connections", ...scopeSegments(ref), "detail", connectionId] as const,
  },
  registry: {
    search: (q: string) => ["mcp-registry", "search", q] as const,
  },
  skills: {
    all: (ref: ScopeRef) => ["skills", ...scopeSegments(ref)] as const,
    list: (ref: ScopeRef) => ["skills", ...scopeSegments(ref), "list"] as const,
    detail: (ref: ScopeRef, skillId: string) =>
      ["skills", ...scopeSegments(ref), "detail", skillId] as const,
  },
  modelPresets: {
    list: (workspaceId: string) => ["model-presets", workspaceId] as const,
  },
  modelAllowlist: {
    list: (workspaceId: string) => ["model-allowlist", workspaceId] as const,
  },
  agents: {
    all: (workspaceId: string) => ["agents", workspaceId] as const,
    list: (workspaceId: string) => ["agents", workspaceId, "list"] as const,
    detail: (workspaceId: string, agentId: string) =>
      ["agents", workspaceId, "detail", agentId] as const,
  },
  members: {
    list: (workspaceId: string) => ["members", workspaceId] as const,
  },
  integrations: {
    all: (workspaceId: string) => ["integrations", workspaceId] as const,
    list: (workspaceId: string) => ["integrations", workspaceId, "list"] as const,
  },
  triggers: {
    all: (workspaceId: string, workflowId: string) =>
      ["triggers", workspaceId, workflowId] as const,
    list: (workspaceId: string, workflowId: string) =>
      ["triggers", workspaceId, workflowId, "list"] as const,
  },
} as const;
