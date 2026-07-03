/**
 * Adapter: control-plane `CompileRequest` → @invisible-string/compiler's pure
 * `compile(definition, deps)` (wired as the default `compile` in
 * createAppStack — this replaces the Integrate-stage placeholder).
 *
 * The control plane resolves rows by UUID and validates preset→model +
 * allowlist BEFORE this runs; the adapter's job is shaping row data into the
 * compiler's resolved-dependency types:
 * - names → slugs (lowercase kebab; must be unique per kind — `@refs` in
 *   instructions address connections/skills by slug)
 * - `authConfigEncrypted` presence → `bearerToken` auth; the generated code
 *   reads `MCP_<SLUG>_TOKEN` (`connectionTokenEnvVar`), which MUST equal the
 *   env var the dispatcher injects (`mcpTokenEnvName(name)` in
 *   runtime/agent-env.ts) — asserted here so drift is a compile error, not a
 *   silently-unauthenticated agent
 * - db approval policy `{default, tools?}` → compiler ApprovalSpec
 * - typed CompileError → WorkflowCompileError (surfaces as a 422)
 *
 * SECRETS DISCIPLINE: nothing here carries a secret VALUE — only env var
 * names ever reach the compiler/generated files.
 */
import {
  compile,
  CompileError,
  connectionTokenEnvVar,
  RUNTIME_VERSIONS,
  COMPILER_VERSION,
  type ApprovalSpec,
  type ResolvedMcpConnection,
  type ResolvedSkill,
  type ToolFilterSpec,
} from "@invisible-string/compiler";

import {
  WorkflowCompileError,
  type CompileConnection,
  type CompileIssue,
  type CompileRequest,
  type CompileResult,
  type CompileSkill,
  type CompileWorkflowFn,
} from "./compiler-contract";

/** Lowercase-kebab slug from a human name (compiler SLUG grammar). */
export function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug;
}

function issue(path: string, message: string): CompileIssue {
  return { path, message };
}

function uniqueSlugs<T extends { name: string }>(
  kind: "connection" | "skill",
  rows: T[],
): Map<T, string> {
  const bySlug = new Map<string, T>();
  const result = new Map<T, string>();
  const problems: CompileIssue[] = [];
  for (const row of rows) {
    const slug = slugifyName(row.name);
    if (slug === "") {
      problems.push(
        issue(`${kind}s.${row.name}`, `${kind} name "${row.name}" produces an empty slug`),
      );
      continue;
    }
    const clash = bySlug.get(slug);
    if (clash) {
      problems.push(
        issue(
          `${kind}s.${row.name}`,
          `${kind}s "${clash.name}" and "${row.name}" both slugify to "${slug}" — rename one`,
        ),
      );
      continue;
    }
    bySlug.set(slug, row);
    result.set(row, slug);
  }
  if (problems.length > 0) throw new WorkflowCompileError(problems);
  return result;
}

const DB_DECISIONS = new Set(["never", "once", "always"]);

/**
 * db `mcp_connections.approval_policy` → compiler ApprovalSpec.
 * Stored shape: `{ default: "never"|"once"|"always", tools?: { <tool>: same } }`
 * ("always" = always ask; "never" = auto-allow). null → never (no gating).
 */
export function approvalSpecFromPolicy(
  connectionName: string,
  policy: Record<string, unknown> | null,
): ApprovalSpec {
  if (policy === null) return { mode: "never" };
  const mode = policy.default ?? "never";
  if (typeof mode !== "string" || !DB_DECISIONS.has(mode)) {
    throw new WorkflowCompileError([
      issue(
        `connections.${connectionName}.approvalPolicy.default`,
        `unknown approval default "${String(mode)}" (expected never|once|always)`,
      ),
    ]);
  }
  const tools = policy.tools;
  if (tools === undefined || tools === null || Object.keys(tools).length === 0) {
    return { mode: mode as "never" | "once" | "always" };
  }
  if (typeof tools !== "object" || Array.isArray(tools)) {
    throw new WorkflowCompileError([
      issue(`connections.${connectionName}.approvalPolicy.tools`, "tools must be an object"),
    ]);
  }
  const rules = Object.entries(tools as Record<string, unknown>).map(([tool, decision]) => {
    if (decision === "always") return { tool, decision: "ask" as const };
    if (decision === "never") return { tool, decision: "allow" as const };
    if (decision === "deny") return { tool, decision: "deny" as const };
    throw new WorkflowCompileError([
      issue(
        `connections.${connectionName}.approvalPolicy.tools.${tool}`,
        `unknown decision "${String(decision)}" (expected always|never|deny)`,
      ),
    ]);
  });
  return {
    mode: "custom",
    rules,
    fallback: mode === "always" ? "ask" : "allow",
  };
}

function toolFilterFrom(
  connection: CompileConnection,
): ToolFilterSpec | undefined {
  const allow = connection.toolAllow;
  const block = connection.toolBlock;
  if (allow && allow.length > 0 && block && block.length > 0) {
    throw new WorkflowCompileError([
      issue(
        `connections.${connection.name}.tools`,
        "a connection may set a tool allowlist OR a blocklist, not both",
      ),
    ]);
  }
  if (allow && allow.length > 0) return { allow };
  if (block && block.length > 0) return { block };
  return undefined;
}

function resolveConnection(
  connection: CompileConnection,
  slug: string,
): ResolvedMcpConnection {
  if (!connection.url) {
    throw new WorkflowCompileError([
      issue(`connections.${connection.name}.url`, "connection has no resolved MCP server URL"),
    ]);
  }
  let auth: ResolvedMcpConnection["auth"] = { kind: "none" };
  if (connection.envTokenVar !== null) {
    const canonical = connectionTokenEnvVar(slug);
    if (connection.envTokenVar !== canonical) {
      // Dispatcher (mcpTokenEnvName) and generated code (connectionTokenEnvVar)
      // must agree on the env var name — a mismatch would boot the agent
      // without its credential.
      throw new WorkflowCompileError([
        issue(
          `connections.${connection.name}.auth`,
          `token env var mismatch: dispatcher injects ${connection.envTokenVar}, generated code reads ${canonical}`,
        ),
      ]);
    }
    auth = { kind: "bearerToken" };
  }
  return {
    id: connection.id,
    slug,
    url: connection.url,
    // Real registry/custom descriptions drive connection_search quality;
    // the placeholder is a last resort for legacy rows without one.
    description:
      connection.description?.trim() || `MCP connection "${connection.name}"`,
    auth,
    tools: toolFilterFrom(connection),
    approval: approvalSpecFromPolicy(connection.name, connection.approvalPolicy),
  };
}

function resolveSkill(skill: CompileSkill, slug: string): ResolvedSkill {
  return {
    id: skill.id,
    slug,
    description: skill.description?.trim() || skill.name,
    markdown: skill.content,
  };
}

/** The production CompileWorkflowFn over @invisible-string/compiler. */
export const compileWorkflow: CompileWorkflowFn = (
  request: CompileRequest,
): CompileResult => {
  const connectionSlugs = uniqueSlugs("connection", request.connections);
  const skillSlugs = uniqueSlugs("skill", request.skills);

  try {
    const compiled = compile(request.definition, {
      versions: RUNTIME_VERSIONS,
      resolvedModel: {
        provider: request.model.provider,
        modelId: request.model.modelId,
      },
      workspaceSlug: request.workspaceSlug,
      workflowSlug: request.workflowSlug,
      agentPreset: {
        id: request.definition.agent.agentPresetId,
        name: request.model.agentName,
        persona: request.model.basePrompt,
        // resolveModel already applied the definition's reasoning override;
        // passing the RESOLVED value as the preset default is equivalent.
        defaultReasoning: request.model.reasoning,
      },
      connections: request.connections.map((connection) =>
        resolveConnection(connection, connectionSlugs.get(connection)!),
      ),
      skills: request.skills.map((skill) => resolveSkill(skill, skillSlugs.get(skill)!)),
    });
    return {
      files: compiled.files,
      hash: compiled.hash,
      compilerVersion: COMPILER_VERSION,
      eveVersion: RUNTIME_VERSIONS.eve,
    };
  } catch (error) {
    if (error instanceof CompileError) {
      throw new WorkflowCompileError([
        { message: `${error.code}: ${error.message}` },
      ]);
    }
    throw error;
  }
};
