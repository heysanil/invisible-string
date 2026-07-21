/**
 * Shared compile-input resolution + dry-run for AGENT publishing (used by
 * agent publish, the agent editor's draft validation, and the dry-run route).
 *
 * The control plane resolves everything the pure compiler needs — the model
 * (definition.model → preset mapping → allowlist), the definition's
 * referenced MCP connections and authored skills (ownership-checked against
 * the agent's run-as user), and skill ATTACHMENT BYTES fetched from the
 * object store — then calls the injected `compile`. Typed errors (422s)
 * surface to the API; a dry run returns compile problems as its PAYLOAD, not
 * a failure.
 *
 * SECRETS DISCIPLINE: this path may decrypt a connection's stored auth to
 * learn its SHAPE (bearer vs headers) and header NAMES so the generated code
 * can read the right env vars — but secret VALUES never reach the compiler or
 * any generated file (only env var names do).
 */
import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { AgentDefinition, ApiErrorInfo, MasterKey } from "@invisible-string/shared";
import { agentDefinitionSchema } from "@invisible-string/shared";

import type { ArtifactStore } from "../artifacts";
import { slugifyName } from "../build/compiler-adapter";
import {
  AgentCompileError,
  type CompileConnection,
  type CompileResult,
  type CompileSkill,
  type CompileAgentFn,
} from "../build/compiler-contract";
import type { Db } from "../db";
import { mcpAuthShape, mcpHeaderEnvName, mcpTokenEnvName } from "./agent-env";
import { errors, isRuntimeApiError } from "./errors";
import {
  loadModelResolutionData,
  resolveModel,
  type ResolvedModel,
} from "./model-resolution";

export interface CompileServiceDeps {
  db: Db;
  masterKey: MasterKey | undefined;
  /** Object store the skill attachments live in (null when S3 is unconfigured). */
  artifacts: ArtifactStore | undefined;
  compile: CompileAgentFn;
}

export interface CompileInputs {
  model: ResolvedModel;
  connections: CompileConnection[];
  skills: CompileSkill[];
  /** Slugified organization slug — baked into the generated project. */
  workspaceSlug: string;
}

/** Shape-guard a stored draft/definition into an AgentDefinition (422). */
export function parseAgentDefinition(raw: unknown): AgentDefinition {
  const parsed = agentDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw errors.draftInvalid(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/**
 * Resolve the definition's referenced resources. Model resolution + allowlist
 * validation run FIRST so their typed errors surface before any compile work.
 * Context resources must be workspace-scoped rows of this workspace or
 * user-scoped rows of the agent's run-as user (spec §2).
 */
export async function resolveCompileInputs(
  deps: CompileServiceDeps,
  organizationId: string,
  runAsUserId: string,
  definition: AgentDefinition,
): Promise<CompileInputs> {
  const { db } = deps;
  const data = await loadModelResolutionData(db, organizationId);
  const model = resolveModel(definition.model, data);

  const orgRows = await db
    .select({ slug: schema.organization.slug })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  const workspaceSlug = slugifyName(orgRows[0]?.slug ?? "") || "workspace";

  const connections: CompileConnection[] = [];
  for (const id of definition.context.mcpConnectionIds) {
    const rows = await db
      .select()
      .from(schema.mcpConnections)
      .where(eq(schema.mcpConnections.id, id))
      .limit(1);
    const row = rows[0];
    const owned =
      row &&
      row.enabled &&
      ((row.scope === "workspace" && row.organizationId === organizationId) ||
        (row.scope === "user" && row.userId === runAsUserId));
    if (!owned) throw errors.contextResourceNotFound("mcp_connection", id);

    // Learn the auth shape (bearer vs headers) + header NAMES without ever
    // baking a secret value into the generated files.
    const shape = mcpAuthShape(row.authConfigEncrypted, deps.masterKey, row.id);
    connections.push({
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      url: row.url,
      envTokenVar: shape.kind === "bearer" ? mcpTokenEnvName(row.name) : null,
      authHeaders:
        shape.kind === "headers"
          ? shape.headerNames.map((header) => ({
              header,
              envVar: mcpHeaderEnvName(row.name, header),
            }))
          : null,
      toolAllow: row.toolAllow ?? null,
      toolBlock: row.toolBlock ?? null,
      approvalPolicy: row.approvalPolicy ?? null,
    });
  }

  const skills: CompileSkill[] = [];
  for (const id of definition.context.skillIds) {
    const rows = await db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, id))
      .limit(1);
    const row = rows[0];
    const owned =
      row &&
      ((row.scope === "workspace" && row.organizationId === organizationId) ||
        (row.scope === "user" && row.userId === runAsUserId));
    if (!owned) throw errors.contextResourceNotFound("skill", id);

    const files = await fetchSkillFiles(deps, row.name, row.files ?? null);
    skills.push({
      id: row.id,
      name: row.name,
      description: row.description,
      content: row.content,
      ...(files ? { files } : {}),
    });
  }

  return { model, connections, skills, workspaceSlug };
}

/**
 * Fetch a skill's attachment bytes from the object store → `{ name: text }`
 * for the compiler (it emits a packaged skill directory). Text-decoded — the
 * eve SKILL.md convention packages text reference files (scripts, docs).
 */
async function fetchSkillFiles(
  deps: CompileServiceDeps,
  skillName: string,
  files: { name: string; key: string; mediaType: string }[] | null,
): Promise<Record<string, string> | undefined> {
  if (!files || files.length === 0) return undefined;
  if (!deps.artifacts) throw errors.skillFilesUnavailable(skillName);
  const decoder = new TextDecoder();
  const out: Record<string, string> = {};
  for (const file of files) {
    let bytes: ArrayBuffer;
    try {
      bytes = await deps.artifacts.getArrayBuffer(file.key);
    } catch {
      throw errors.skillFileMissing(skillName, file.name);
    }
    out[file.name] = decoder.decode(bytes);
  }
  return out;
}

export function compileOrThrow(
  compile: CompileAgentFn,
  definition: AgentDefinition,
  inputs: CompileInputs,
  agentName: string,
): CompileResult {
  try {
    return compile({
      definition,
      model: inputs.model,
      connections: inputs.connections,
      skills: inputs.skills,
      workspaceSlug: inputs.workspaceSlug,
      agentSlug: slugifyName(agentName) || "agent",
    });
  } catch (error) {
    if (error instanceof AgentCompileError) {
      throw errors.compileFailed(error.issues);
    }
    throw error;
  }
}

/** Result of a dry-run compile — problems are the PAYLOAD, not a failure. */
export type DryRunResult =
  | { ok: true; contentHash: string }
  | { ok: false; error: ApiErrorInfo };

/**
 * Compile the RAW draft without persisting anything. Shape problems, model/
 * allowlist problems, and compile problems (all 422s) become
 * `{ ok: false, error }`; anything else propagates.
 */
export async function dryRunCompile(
  deps: CompileServiceDeps,
  organizationId: string,
  runAsUserId: string,
  agentName: string,
  draft: unknown,
): Promise<DryRunResult> {
  try {
    const definition = parseAgentDefinition(draft);
    const inputs = await resolveCompileInputs(
      deps,
      organizationId,
      runAsUserId,
      definition,
    );
    const compiled = compileOrThrow(deps.compile, definition, inputs, agentName);
    return { ok: true, contentHash: compiled.hash };
  } catch (error) {
    if (isRuntimeApiError(error) && error.status === 422) {
      return { ok: false, error: error.toBody().error };
    }
    throw error;
  }
}
