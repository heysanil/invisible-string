/**
 * compile(definition, deps) → { files, hash }
 *
 * The PURE agent → eve-project code generator (docs/PLAN.md Phase 1 task 2,
 * re-keyed by the agents-first redesign: the AGENT is the compile unit). No
 * I/O beyond its inputs; deterministic; throws typed CompileError on any
 * internally inconsistent input. The reference implementation for everything
 * emitted here is the Phase-0 spike project (spike/agent-project) — these
 * templates mirror what it PROVED works.
 *
 * The artifact is trigger-agnostic: it emits ONLY the default eve channel.
 * Workflow instructions and `@trigger.*` data are rendered into the task
 * message at DISPATCH time by the control plane (`renderTaskMessage` in
 * packages/shared), never compiled in.
 */
import {
  agentDefinitionSchema,
  type AgentDefinition,
} from "@invisible-string/shared";

import { emitAgentTs } from "./codegen/agent";
import { emitEveChannel } from "./codegen/channels";
import { emitConnection } from "./codegen/connections";
import { emitEnvLib, emitPlatformAuthLib } from "./codegen/libs";
import { emitPackageJson, emitTsconfig } from "./codegen/project";
import { emitSkill } from "./codegen/skills";
import {
  ENV_NAME_PATTERN,
  HEADER_NAME_PATTERN,
  SLUG_PATTERN,
} from "./codegen/strings";
import { CompileError } from "./errors";
import { computeAgentHash } from "./hash";
import { renderInstructions } from "./instructions";
import type {
  CompileDeps,
  CompileResult,
  ResolvedMcpConnection,
  ResolvedSkill,
} from "./types";

const MODEL_PROVIDERS = new Set(["openrouter", "anthropic"]);

function assertSlug(kind: string, slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new CompileError(
      "INVALID_SLUG",
      `${kind} slug "${slug}" must be lowercase kebab-case ([a-z0-9-], 1-64 chars, no leading/trailing "-")`,
      { kind, slug },
    );
  }
}

function validateDeps(definition: AgentDefinition, deps: CompileDeps): void {
  if (!MODEL_PROVIDERS.has(deps.resolvedModel.provider)) {
    throw new CompileError(
      "INVALID_DEPS",
      `unsupported model provider "${String(deps.resolvedModel.provider)}"`,
      { provider: deps.resolvedModel.provider },
    );
  }
  if (deps.resolvedModel.modelId.trim().length === 0) {
    throw new CompileError("INVALID_DEPS", "resolvedModel.modelId is empty");
  }
  assertSlug("workspace", deps.workspaceSlug);
  assertSlug("agent", deps.agentSlug);

  // Model resolution happens upstream, but an explicit modelId override in
  // the definition MUST be what the control plane resolved (spec §7: the
  // override wins) — anything else is an internally inconsistent input.
  if (
    definition.model.modelId !== undefined &&
    definition.model.modelId !== deps.resolvedModel.modelId
  ) {
    throw new CompileError(
      "MODEL_MISMATCH",
      `definition.model.modelId "${definition.model.modelId}" does not match deps.resolvedModel.modelId "${deps.resolvedModel.modelId}"`,
      {
        definitionModelId: definition.model.modelId,
        resolvedModelId: deps.resolvedModel.modelId,
      },
    );
  }
}

function validateJoin<T extends { id: string; slug: string }>(
  kind: "connection" | "skill",
  referencedIds: readonly string[],
  resolved: readonly T[],
): void {
  const resolvedById = new Map(resolved.map((entry) => [entry.id, entry]));
  for (const id of referencedIds) {
    if (!resolvedById.has(id)) {
      throw new CompileError(
        kind === "connection" ? "MISSING_CONNECTION" : "MISSING_SKILL",
        `definition references ${kind} ${id} but deps.${kind}s has no entry for it`,
        { id },
      );
    }
  }
  const referenced = new Set(referencedIds);
  for (const entry of resolved) {
    if (!referenced.has(entry.id)) {
      throw new CompileError(
        kind === "connection" ? "UNEXPECTED_CONNECTION" : "UNEXPECTED_SKILL",
        `deps.${kind}s contains ${kind} ${entry.id} ("${entry.slug}") the definition does not reference`,
        { id: entry.id, slug: entry.slug },
      );
    }
  }
  const seenSlugs = new Set<string>();
  for (const entry of resolved) {
    assertSlug(kind, entry.slug);
    if (seenSlugs.has(entry.slug)) {
      throw new CompileError(
        "DUPLICATE_SLUG",
        `two resolved ${kind}s share the slug "${entry.slug}"`,
        { slug: entry.slug },
      );
    }
    seenSlugs.add(entry.slug);
  }
}

/**
 * Query-parameter names that look like credentials. Connection URLs are
 * emitted as LITERALS in generated files — a token smuggled through the URL
 * would violate the "secrets never in generated files" rule via the side
 * door, so such URLs are rejected at compile (fail closed; steer these
 * servers to the bearer/header env-var auth path).
 */
const CREDENTIAL_QUERY_PARAM = /^(api[-_]?key|apikey|token|access[-_]?token|auth|authorization|bearer|secret|password|key|sig|signature)$/i;

function validateConnection(connection: ResolvedMcpConnection): void {
  if (connection.url.trim().length === 0) {
    throw new CompileError(
      "INVALID_DEPS",
      `connection "${connection.slug}" has an empty url`,
      { slug: connection.slug },
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(connection.url);
  } catch {
    throw new CompileError(
      "INVALID_DEPS",
      `connection "${connection.slug}" url is not a valid URL`,
      { slug: connection.slug },
    );
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new CompileError(
      "INVALID_DEPS",
      `connection "${connection.slug}" url embeds userinfo credentials — URLs are emitted as literals in generated files; use bearer-token or header env-var auth instead`,
      { slug: connection.slug },
    );
  }
  for (const param of parsedUrl.searchParams.keys()) {
    if (CREDENTIAL_QUERY_PARAM.test(param)) {
      throw new CompileError(
        "INVALID_DEPS",
        `connection "${connection.slug}" url carries a credential-looking query parameter "${param}" — URLs are emitted as literals in generated files; use bearer-token or header env-var auth instead`,
        { slug: connection.slug, param },
      );
    }
  }
  if (connection.description.trim().length === 0) {
    throw new CompileError(
      "INVALID_DEPS",
      `connection "${connection.slug}" has an empty description — connection_search routes on it`,
      { slug: connection.slug },
    );
  }
  if (connection.auth.kind === "headers") {
    const entries = Object.entries(connection.auth.headers);
    if (entries.length === 0) {
      throw new CompileError(
        "INVALID_HEADER",
        `connection "${connection.slug}" uses headers auth with no headers`,
        { slug: connection.slug },
      );
    }
    for (const [header, envName] of entries) {
      if (!HEADER_NAME_PATTERN.test(header)) {
        throw new CompileError(
          "INVALID_HEADER",
          `connection "${connection.slug}" has an invalid header name "${header}"`,
          { slug: connection.slug, header },
        );
      }
      if (!ENV_NAME_PATTERN.test(envName)) {
        throw new CompileError(
          "INVALID_HEADER",
          `connection "${connection.slug}" header "${header}" names an invalid env var "${envName}" (expected ${String(ENV_NAME_PATTERN)}) — headers carry ENV VAR NAMES, never secret values`,
          { slug: connection.slug, header, envName },
        );
      }
    }
  }
  if (connection.tools !== undefined) {
    const hasAllow = connection.tools.allow !== undefined;
    const hasBlock = connection.tools.block !== undefined;
    if (hasAllow === hasBlock) {
      throw new CompileError(
        "INVALID_TOOL_FILTER",
        `connection "${connection.slug}" tools filter must carry exactly one of allow/block`,
        { slug: connection.slug },
      );
    }
    const list = connection.tools.allow ?? connection.tools.block ?? [];
    if (list.length === 0 || list.some((tool) => tool.trim().length === 0)) {
      throw new CompileError(
        "INVALID_TOOL_FILTER",
        `connection "${connection.slug}" tools filter must list at least one non-empty tool name`,
        { slug: connection.slug },
      );
    }
  }
  if (connection.approval.mode === "custom") {
    const { rules } = connection.approval;
    if (rules.length === 0) {
      throw new CompileError(
        "INVALID_APPROVAL",
        `connection "${connection.slug}" custom approval has no rules — use mode "never"/"once"/"always" instead`,
        { slug: connection.slug },
      );
    }
    const seen = new Set<string>();
    for (const rule of rules) {
      if (rule.tool.trim().length === 0) {
        throw new CompileError(
          "INVALID_APPROVAL",
          `connection "${connection.slug}" custom approval has an empty tool name`,
          { slug: connection.slug },
        );
      }
      if (rule.tool.includes("__")) {
        throw new CompileError(
          "INVALID_APPROVAL",
          `connection "${connection.slug}" approval rule tool "${rule.tool}" must be the BARE remote tool name — the compiler qualifies it as "${connection.slug}__<tool>"`,
          { slug: connection.slug, tool: rule.tool },
        );
      }
      if (seen.has(rule.tool)) {
        throw new CompileError(
          "INVALID_APPROVAL",
          `connection "${connection.slug}" has duplicate approval rules for tool "${rule.tool}"`,
          { slug: connection.slug, tool: rule.tool },
        );
      }
      seen.add(rule.tool);
    }
  }
}

function validateSkill(skill: ResolvedSkill): void {
  if (skill.description.trim().length === 0) {
    throw new CompileError(
      "INVALID_DEPS",
      `skill "${skill.slug}" has an empty description — eve routes load_skill on it`,
      { slug: skill.slug },
    );
  }
  if (skill.markdown.trim().length === 0) {
    throw new CompileError(
      "INVALID_DEPS",
      `skill "${skill.slug}" has empty markdown`,
      { slug: skill.slug },
    );
  }
  for (const relativePath of Object.keys(skill.files ?? {})) {
    const segments = relativePath.split("/");
    const invalid =
      relativePath.length === 0 ||
      relativePath.startsWith("/") ||
      relativePath.endsWith("/") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      relativePath === "SKILL.md";
    if (invalid) {
      throw new CompileError(
        "INVALID_SKILL_FILE",
        `skill "${skill.slug}" file path "${relativePath}" must be a relative path inside the skill directory (and not SKILL.md itself)`,
        { slug: skill.slug, path: relativePath },
      );
    }
  }
}

/**
 * Compile an agent definition into a complete, buildable eve project.
 *
 * @returns `files` — project-root-relative path → content — and `hash`, the
 * deterministic agent-version hash (see hash.ts for exactly what it covers).
 * Same input → same files and same hash.
 */
export function compile(
  definition: AgentDefinition,
  deps: CompileDeps,
): CompileResult {
  const parsedDefinition = agentDefinitionSchema.safeParse(definition);
  if (!parsedDefinition.success) {
    throw new CompileError(
      "INVALID_DEFINITION",
      `agent definition failed validation: ${parsedDefinition.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
      { issues: parsedDefinition.error.issues },
    );
  }
  const def = parsedDefinition.data;

  validateDeps(def, deps);
  validateJoin("connection", def.context.mcpConnectionIds, deps.connections);
  validateJoin("skill", def.context.skillIds, deps.skills);
  for (const connection of deps.connections) validateConnection(connection);
  for (const skill of deps.skills) validateSkill(skill);

  // Emission order matters for readability only — determinism comes from
  // sorting resolved entries by slug and fixed template output.
  const connections = [...deps.connections].sort((a, b) =>
    a.slug < b.slug ? -1 : 1,
  );
  const skills = [...deps.skills].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const sortedDeps: CompileDeps = { ...deps, connections, skills };

  const rendered = renderInstructions(def, sortedDeps);
  const dev = deps.options?.dev === true;

  // The hash is a pure function of the INPUTS (never of the emitted bytes),
  // so it can be computed up front and baked into the generated code — the
  // platform-auth JWT audience is bound to this version's hash.
  const hash = computeAgentHash(def, deps);

  const files = new Map<string, string>();
  files.set("package.json", emitPackageJson(sortedDeps));
  files.set("tsconfig.json", emitTsconfig());
  files.set("agent/agent.ts", emitAgentTs(sortedDeps, def.model.reasoning));
  files.set("agent/instructions.md", rendered.markdown);
  files.set("agent/lib/platform-auth.ts", emitPlatformAuthLib(dev, hash));
  if (connections.some((connection) => connection.auth.kind !== "none")) {
    files.set("agent/lib/env.ts", emitEnvLib());
  }
  files.set("agent/channels/eve.ts", emitEveChannel(sortedDeps));

  for (const connection of connections) {
    files.set(
      `agent/connections/${connection.slug}.ts`,
      emitConnection(connection),
    );
  }
  for (const skill of skills) {
    for (const [path, content] of emitSkill(skill)) {
      files.set(path, content);
    }
  }

  // computeAgentHash canonicalizes key order AND resolved-entry array order
  // itself, so this matches control-plane pre-computed hashes.
  return { files, hash };
}
