/**
 * Proposal validation: zod schema (shared, per tool) + semantic checks
 * against the fresh workspace inventory AND the turn's draft state. Invalid
 * tool calls never reach the client — they come back to the model as tool
 * errors so it self-corrects.
 *
 * The draft-state checks mirror the compiler's publish-time rules
 * (packages/compiler/src/instructions.ts) so an applied proposal never
 * produces a draft that publish rejects:
 * - `@connection` / `@skill.slug` refs must resolve to context ATTACHED to
 *   the workflow (draft context ∪ addContext proposals accepted earlier in
 *   the same turn), not merely to the workspace inventory;
 * - `@trigger.*` refs must be non-bare, allowed for the (possibly
 *   turn-updated) trigger type, and match a form field key for form triggers;
 * - addContext must point at an ENABLED connection (publish resolution drops
 *   disabled rows with context_resource_not_found).
 */
import {
  copilotMutationParamSchemas,
  parseReferences,
  triggerConfigSchema,
  type CopilotMutationParams,
  type CopilotMutationTool,
  type TriggerConfig,
} from "@invisible-string/shared";

import type { WorkspaceInventory } from "./inventory";

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
 * session.ts) so a setInstructions following an accepted addContext /
 * setTrigger validates against what the draft will actually contain.
 */
export interface DraftContextState {
  connectionIds: Set<string>;
  skillIds: Set<string>;
  /** null when the draft's trigger doesn't parse (lenient mid-edit drafts). */
  trigger: TriggerConfig | null;
}

/** Parse the loose client draft into the state the semantic checks need. */
export function draftContextState(
  draft: Record<string, unknown>,
): DraftContextState {
  const context = (draft.context ?? {}) as Record<string, unknown>;
  const ids = (value: unknown): Set<string> =>
    new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
    );
  const trigger = triggerConfigSchema.safeParse(draft.trigger);
  return {
    connectionIds: ids(context.mcpConnectionIds),
    skillIds: ids(context.skillIds),
    trigger: trigger.success ? trigger.data : null,
  };
}

/** Apply an ACCEPTED mutation to the turn's draft state (session bookkeeping). */
export function applyAcceptedMutation(
  state: DraftContextState,
  tool: CopilotMutationTool,
  params: CopilotMutationParams[CopilotMutationTool],
): void {
  switch (tool) {
    case "setTrigger":
      state.trigger = (params as CopilotMutationParams["setTrigger"]).trigger;
      break;
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
 * Mirror of the compiler's `validateTriggerPath` — returns a model-facing
 * problem string instead of throwing (null = valid).
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

/**
 * Validate a raw model tool call. Returns parsed params on success or a
 * model-facing error message describing how to fix the call. When
 * `draftState` is provided (the session always passes it), setInstructions
 * refs and addContext are additionally checked against the draft the
 * mutation would actually land on.
 */
export function validateMutation(
  toolName: string,
  input: unknown,
  inventory: WorkspaceInventory,
  draftState?: DraftContextState,
): MutationValidation {
  if (!isMutationTool(toolName)) {
    return invalid(`unknown tool "${toolName}"`);
  }
  const parsed = copilotMutationParamSchemas[toolName].safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return invalid(`invalid ${toolName} params — ${issues}`);
  }
  const params = parsed.data as CopilotMutationParams[CopilotMutationTool];

  switch (toolName) {
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
        return invalid(
          `${kind} id "${id}" does not exist in this workspace — known ${kind}s: ${known || "(none)"}`,
        );
      }
      // Attaching a DISABLED connection compiles to context_resource_not_found
      // at publish; detaching one is always fine.
      if (
        toolName === "addContext" &&
        kind === "connection" &&
        "enabled" in item &&
        item.enabled === false
      ) {
        const enabledNames = inventory.connections
          .filter((connection) => connection.enabled)
          .map((connection) => `${connection.id} (${connection.name})`)
          .join(", ");
        return invalid(
          `connection "${item.name}" is disabled and cannot be attached — enabled connections: ${enabledNames || "(none)"}`,
        );
      }
      break;
    }
    case "setAgent": {
      const agent = params as CopilotMutationParams["setAgent"];
      if (
        agent.agentPresetId !== undefined &&
        !inventory.agentPresets.some((preset) => preset.id === agent.agentPresetId)
      ) {
        const known = inventory.agentPresets
          .map((preset) => `${preset.id} (${preset.name})`)
          .join(", ");
        return invalid(
          `agent preset id "${agent.agentPresetId}" does not exist — known presets: ${known || "(none)"}`,
        );
      }
      if (
        agent.modelId !== undefined &&
        !inventory.allowlist.some(
          (entry) => entry.enabled && entry.modelId === agent.modelId,
        )
      ) {
        const allowed = inventory.allowlist
          .filter((entry) => entry.enabled)
          .map((entry) => entry.modelId)
          .join(", ");
        return invalid(
          `model "${agent.modelId}" is not on this workspace's allowlist — allowed: ${allowed || "(none)"}`,
        );
      }
      break;
    }
    case "setInstructions": {
      const { markdown } = params as CopilotMutationParams["setInstructions"];
      const problems: string[] = [];
      // Disabled connections are excluded: their refs fail publish resolution.
      const enabledConnections = inventory.connections.filter(
        (connection) => connection.enabled,
      );
      const attachedConnectionSlugs = draftState
        ? new Set(
            enabledConnections
              .filter((connection) => draftState.connectionIds.has(connection.id))
              .map((connection) => connection.slug),
          )
        : null;
      const attachedSkillSlugs = draftState
        ? new Set(
            inventory.skills
              .filter((skill) => draftState.skillIds.has(skill.id))
              .map((skill) => skill.slug),
          )
        : null;
      for (const ref of parseReferences(markdown)) {
        if (ref.kind === "connection") {
          if (!enabledConnections.some((c) => c.slug === ref.name)) {
            problems.push(
              `"${ref.raw}" references an unknown connection (known: ${
                enabledConnections.map((c) => `@${c.slug}`).join(", ") || "(none)"
              })`,
            );
          } else if (
            attachedConnectionSlugs &&
            !attachedConnectionSlugs.has(ref.name)
          ) {
            problems.push(
              `"${ref.raw}" references a connection that is not attached to this workflow's context — propose addContext for it first (attached: ${
                [...attachedConnectionSlugs].map((slug) => `@${slug}`).join(", ") ||
                "(none)"
              })`,
            );
          }
        } else if (ref.kind === "skill") {
          if (ref.slug === "" || !inventory.skills.some((s) => s.slug === ref.slug)) {
            problems.push(
              `"${ref.raw}" references an unknown skill (known: ${
                inventory.skills.map((s) => `@skill.${s.slug}`).join(", ") || "(none)"
              })`,
            );
          } else if (attachedSkillSlugs && !attachedSkillSlugs.has(ref.slug)) {
            problems.push(
              `"${ref.raw}" references a skill that is not attached to this workflow's context — propose addContext for it first (attached: ${
                [...attachedSkillSlugs]
                  .map((slug) => `@skill.${slug}`)
                  .join(", ") || "(none)"
              })`,
            );
          }
        } else if (ref.kind === "trigger" && draftState?.trigger) {
          const problem = triggerRefProblem(draftState.trigger, ref.path, ref.raw);
          if (problem) problems.push(problem);
        }
      }
      if (problems.length > 0) {
        return invalid(
          `instructions reference resources that would fail to publish: ${problems.join("; ")}. ` +
            "Only reference attached workspace connections/skills (propose addContext first) and valid @trigger paths.",
        );
      }
      break;
    }
    case "setTrigger":
    case "setModelPreset":
      // Fully covered by the zod schema (setModelPreset slugs are the three
      // fixed workspace presets; trigger config is shape-validated).
      break;
  }

  return { ok: true, tool: toolName, params };
}
