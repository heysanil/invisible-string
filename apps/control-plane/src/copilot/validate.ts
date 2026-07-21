/**
 * Proposal validation: zod schema (shared, per tool) + semantic checks
 * against the fresh workspace inventory AND the turn's draft state. Invalid
 * tool calls never reach the client — they come back to the model as tool
 * errors so it self-corrects.
 *
 * Split per surface (design §5.7); the draft state carries the surface
 * discriminant, so a tool from the other surface is rejected outright. The
 * checks mirror the publish-time rules so an applied proposal never produces
 * a draft that publish rejects:
 *
 * workflow surface (workflow publish validator parity):
 * - `setAgent` must name an EXISTING, PUBLISHED agent;
 * - `setInstructions` `@connection`/`@skill.slug` refs must be within the
 *   SELECTED agent's published context (draft agent ∪ setAgent proposals
 *   accepted earlier in the same turn);
 * - `@trigger.*` refs must be non-bare, allowed for the (possibly
 *   turn-updated) trigger type, and match a form field key for form triggers.
 *
 * agent surface (compiler parity, packages/compiler/src/instructions.ts):
 * - `setPersona` refs must resolve to context ATTACHED to the agent (draft
 *   context ∪ addContext proposals accepted earlier in the same turn), and
 *   `@trigger.*` is rejected (compile error TRIGGER_REF_NOT_ALLOWED);
 * - `addContext` must point at an ENABLED connection (publish resolution
 *   drops disabled rows with context_resource_not_found);
 * - `setModel.modelId` must be on the enabled workspace allowlist.
 */
import {
  agentCopilotMutationParamSchemas,
  copilotMutationParamSchemas,
  parseReferences,
  triggerConfigSchema,
  workflowCopilotMutationParamSchemas,
  type CopilotMutationParams,
  type CopilotMutationTool,
  type CopilotSurface,
  type TriggerConfig,
} from "@invisible-string/shared";

import type { InventoryAgent, WorkspaceInventory } from "./inventory";

export type MutationValidation =
  | {
      ok: true;
      tool: CopilotMutationTool;
      params: CopilotMutationParams[CopilotMutationTool];
    }
  | { ok: false; message: string };

/**
 * The draft state a turn validates against — seeded from the client's draft
 * at turn start and updated as the user ACCEPTS proposals mid-turn (see
 * session.ts) so later calls in the same turn validate against what the
 * draft will actually contain (a setInstructions following an accepted
 * setAgent/setTrigger, a setPersona following an accepted addContext).
 */
export interface WorkflowDraftState {
  surface: "workflow";
  /** null when the draft's trigger doesn't parse (lenient mid-edit drafts). */
  trigger: TriggerConfig | null;
  /** The selected agent (`workflows.draft.agentId`); null while drafting. */
  agentId: string | null;
}

export interface AgentDraftState {
  surface: "agent";
  connectionIds: Set<string>;
  skillIds: Set<string>;
}

export type CopilotDraftState = WorkflowDraftState | AgentDraftState;

/** Parse the loose client draft into the state the semantic checks need. */
export function draftStateFor(
  surface: CopilotSurface,
  draft: Record<string, unknown>,
): CopilotDraftState {
  if (surface === "workflow") {
    const trigger = triggerConfigSchema.safeParse(draft.trigger);
    return {
      surface,
      trigger: trigger.success ? trigger.data : null,
      agentId: typeof draft.agentId === "string" ? draft.agentId : null,
    };
  }
  const context = (draft.context ?? {}) as Record<string, unknown>;
  const ids = (value: unknown): Set<string> =>
    new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
    );
  return {
    surface,
    connectionIds: ids(context.mcpConnectionIds),
    skillIds: ids(context.skillIds),
  };
}

/** Apply an ACCEPTED mutation to the turn's draft state (session bookkeeping). */
export function applyAcceptedMutation(
  state: CopilotDraftState,
  tool: CopilotMutationTool,
  params: CopilotMutationParams[CopilotMutationTool],
): void {
  if (state.surface === "workflow") {
    switch (tool) {
      case "setTrigger":
        state.trigger = (params as CopilotMutationParams["setTrigger"]).trigger;
        break;
      case "setAgent":
        state.agentId = (params as CopilotMutationParams["setAgent"]).agentId;
        break;
      default:
        break;
    }
    return;
  }
  switch (tool) {
    case "addContext": {
      const { kind, id } = params as CopilotMutationParams["addContext"];
      (kind === "connection" ? state.connectionIds : state.skillIds).add(id);
      break;
    }
    case "removeContext": {
      const { kind, id } = params as CopilotMutationParams["removeContext"];
      (kind === "connection" ? state.connectionIds : state.skillIds).delete(id);
      break;
    }
    default:
      break;
  }
}

function invalid(message: string): MutationValidation {
  return { ok: false, message };
}

export function isMutationTool(name: string): name is CopilotMutationTool {
  return name in copilotMutationParamSchemas;
}

/** Trigger types whose dispatch envelope carries `data` for `@trigger.*`. */
function triggerCarriesData(trigger: TriggerConfig): boolean {
  return (
    trigger.type === "form" ||
    trigger.type === "webhook" ||
    trigger.type === "slack"
  );
}

/**
 * Mirror of the workflow publish validator's trigger-path rule — returns a
 * model-facing problem string instead of throwing (null = valid).
 */
function triggerRefProblem(
  trigger: TriggerConfig,
  path: string,
  raw: string,
): string | null {
  if (path === "") {
    return `bare "@trigger" reference — name a data path like "@trigger.email"`;
  }
  if (!triggerCarriesData(trigger)) {
    return `"${raw}" cannot be used with a "${trigger.type}" trigger — it carries no dispatch data (propose setTrigger to a form/webhook/slack trigger first)`;
  }
  if (trigger.type === "form") {
    const head = path.split(".")[0] ?? "";
    if (!trigger.fields.some((field) => field.key === head)) {
      return `"${raw}" does not match any form field key (fields: ${trigger.fields
        .map((field) => field.key)
        .join(", ")})`;
    }
  }
  return null;
}

function describePublishedAgents(inventory: WorkspaceInventory): string {
  const published = inventory.agents
    .filter((agent) => agent.published)
    .map((agent) => `${agent.id} (${agent.name})`)
    .join(", ");
  return published || "(none)";
}

/** Context slugs of a published agent, formatted for a model-facing hint. */
function describeAgentContext(agent: InventoryAgent): string {
  const slugs = [
    ...agent.contextConnectionSlugs.map((slug) => `@${slug}`),
    ...agent.contextSkillSlugs.map((slug) => `@skill.${slug}`),
  ].join(", ");
  return slugs || "(none)";
}

/**
 * Validate a raw model tool call against the turn's surface (carried on
 * `draftState`). Returns parsed params on success or a model-facing error
 * message describing how to fix the call.
 */
export function validateMutation(
  toolName: string,
  input: unknown,
  inventory: WorkspaceInventory,
  draftState: CopilotDraftState,
): MutationValidation {
  const registry =
    draftState.surface === "workflow"
      ? workflowCopilotMutationParamSchemas
      : agentCopilotMutationParamSchemas;
  if (!(toolName in registry)) {
    if (isMutationTool(toolName)) {
      return invalid(
        `tool "${toolName}" is not available on the ${draftState.surface} surface (available: ${Object.keys(registry).join(", ")})`,
      );
    }
    return invalid(`unknown tool "${toolName}"`);
  }
  const tool = toolName as CopilotMutationTool;
  const parsed = copilotMutationParamSchemas[tool].safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return invalid(`invalid ${tool} params — ${issues}`);
  }
  const params = parsed.data as CopilotMutationParams[CopilotMutationTool];

  const problem =
    draftState.surface === "workflow"
      ? workflowSemanticProblem(tool, params, inventory, draftState)
      : agentSemanticProblem(tool, params, inventory, draftState);
  if (problem) return invalid(problem);

  return { ok: true, tool, params };
}

// ── workflow-surface semantics ───────────────────────────────────────────────

function workflowSemanticProblem(
  tool: CopilotMutationTool,
  params: CopilotMutationParams[CopilotMutationTool],
  inventory: WorkspaceInventory,
  draftState: WorkflowDraftState,
): string | null {
  switch (tool) {
    case "setAgent": {
      const { agentId } = params as CopilotMutationParams["setAgent"];
      const agent = inventory.agents.find(
        (candidate) => candidate.id === agentId,
      );
      if (!agent) {
        const known = inventory.agents
          .map((candidate) => `${candidate.id} (${candidate.name})`)
          .join(", ");
        return `agent id "${agentId}" does not exist in this workspace — known agents: ${known || "(none)"}`;
      }
      // Publish snapshots require a PUBLISHED agent; dispatch resolves its
      // current published version.
      if (!agent.published) {
        return `agent "${agent.name}" has no published version and cannot handle workflow runs yet — published agents: ${describePublishedAgents(inventory)}`;
      }
      return null;
    }
    case "setInstructions": {
      const { markdown } = params as CopilotMutationParams["setInstructions"];
      const problems: string[] = [];
      const selected = draftState.agentId
        ? inventory.agents.find((agent) => agent.id === draftState.agentId)
        : undefined;
      const contextProblem = (raw: string, has: boolean): string | null => {
        if (!draftState.agentId) {
          return `"${raw}" references agent context but the draft has no agent — propose setAgent first`;
        }
        if (!selected) {
          return `"${raw}" references agent context but the selected agent no longer exists — propose setAgent to a published agent (${describePublishedAgents(inventory)})`;
        }
        if (!selected.published) {
          return `"${raw}" references agent context but agent "${selected.name}" has no published version — propose setAgent to a published agent (${describePublishedAgents(inventory)})`;
        }
        if (!has) {
          return `"${raw}" is not in agent "${selected.name}"'s published context (available: ${describeAgentContext(selected)})`;
        }
        return null;
      };
      for (const ref of parseReferences(markdown)) {
        if (ref.kind === "connection") {
          const found = contextProblem(
            ref.raw,
            selected?.contextConnectionSlugs.includes(ref.name) ?? false,
          );
          if (found) problems.push(found);
        } else if (ref.kind === "skill") {
          const found = contextProblem(
            ref.raw,
            ref.slug !== "" &&
              (selected?.contextSkillSlugs.includes(ref.slug) ?? false),
          );
          if (found) problems.push(found);
        } else if (draftState.trigger) {
          const found = triggerRefProblem(draftState.trigger, ref.path, ref.raw);
          if (found) problems.push(found);
        }
      }
      if (problems.length > 0) {
        return (
          `instructions reference resources that would fail to publish: ${problems.join("; ")}. ` +
          "Only reference the selected agent's published context and valid @trigger paths."
        );
      }
      return null;
    }
    case "setTrigger":
      // Fully covered by the zod schema (shape-validated trigger union).
      return null;
    default:
      return null;
  }
}

// ── agent-surface semantics ──────────────────────────────────────────────────

function agentSemanticProblem(
  tool: CopilotMutationTool,
  params: CopilotMutationParams[CopilotMutationTool],
  inventory: WorkspaceInventory,
  draftState: AgentDraftState,
): string | null {
  switch (tool) {
    case "addContext":
    case "removeContext": {
      const { kind, id } = params as CopilotMutationParams["addContext"];
      const pool =
        kind === "connection" ? inventory.connections : inventory.skills;
      const item = pool.find((candidate) => candidate.id === id);
      if (!item) {
        const known = pool
          .map((candidate) => `${candidate.id} (${candidate.name})`)
          .join(", ");
        return `${kind} id "${id}" does not exist in this workspace — known ${kind}s: ${known || "(none)"}`;
      }
      // Attaching a DISABLED connection fails publish resolution with
      // context_resource_not_found; detaching one is always fine.
      if (
        tool === "addContext" &&
        kind === "connection" &&
        "enabled" in item &&
        item.enabled === false
      ) {
        const enabledNames = inventory.connections
          .filter((connection) => connection.enabled)
          .map((connection) => `${connection.id} (${connection.name})`)
          .join(", ");
        return `connection "${item.name}" is disabled and cannot be attached — enabled connections: ${enabledNames || "(none)"}`;
      }
      return null;
    }
    case "setModel": {
      const model = params as CopilotMutationParams["setModel"];
      if (
        model.modelId !== undefined &&
        !inventory.allowlist.some(
          (entry) => entry.enabled && entry.modelId === model.modelId,
        )
      ) {
        const allowed = inventory.allowlist
          .filter((entry) => entry.enabled)
          .map((entry) => entry.modelId)
          .join(", ");
        return `model "${model.modelId}" is not on this workspace's allowlist — allowed: ${allowed || "(none)"}`;
      }
      return null;
    }
    case "setPersona": {
      const { markdown } = params as CopilotMutationParams["setPersona"];
      const problems: string[] = [];
      // Disabled connections are excluded: their refs fail publish resolution.
      const enabledConnections = inventory.connections.filter(
        (connection) => connection.enabled,
      );
      const attachedConnectionSlugs = new Set(
        enabledConnections
          .filter((connection) => draftState.connectionIds.has(connection.id))
          .map((connection) => connection.slug),
      );
      const attachedSkillSlugs = new Set(
        inventory.skills
          .filter((skill) => draftState.skillIds.has(skill.id))
          .map((skill) => skill.slug),
      );
      for (const ref of parseReferences(markdown)) {
        if (ref.kind === "trigger") {
          // Compiler parity: TRIGGER_REF_NOT_ALLOWED at agent publish.
          problems.push(
            `"${ref.raw}" is not allowed in an agent persona — trigger data exists only in workflow instructions`,
          );
        } else if (ref.kind === "connection") {
          if (!enabledConnections.some((c) => c.slug === ref.name)) {
            problems.push(
              `"${ref.raw}" references an unknown connection (known: ${
                enabledConnections.map((c) => `@${c.slug}`).join(", ") || "(none)"
              })`,
            );
          } else if (!attachedConnectionSlugs.has(ref.name)) {
            problems.push(
              `"${ref.raw}" references a connection that is not attached to this agent's context — propose addContext for it first (attached: ${
                [...attachedConnectionSlugs].map((slug) => `@${slug}`).join(", ") ||
                "(none)"
              })`,
            );
          }
        } else {
          if (ref.slug === "" || !inventory.skills.some((s) => s.slug === ref.slug)) {
            problems.push(
              `"${ref.raw}" references an unknown skill (known: ${
                inventory.skills.map((s) => `@skill.${s.slug}`).join(", ") || "(none)"
              })`,
            );
          } else if (!attachedSkillSlugs.has(ref.slug)) {
            problems.push(
              `"${ref.raw}" references a skill that is not attached to this agent's context — propose addContext for it first (attached: ${
                [...attachedSkillSlugs]
                  .map((slug) => `@skill.${slug}`)
                  .join(", ") || "(none)"
              })`,
            );
          }
        }
      }
      if (problems.length > 0) {
        return (
          `persona references resources that would fail to publish: ${problems.join("; ")}. ` +
          "Only reference attached workspace connections/skills (propose addContext first); never @trigger."
        );
      }
      return null;
    }
    default:
      return null;
  }
}
