/**
 * Proposal validation: zod schema (shared, per tool) + semantic checks
 * against the fresh workspace inventory. Invalid tool calls never reach the
 * client — they come back to the model as tool errors so it self-corrects.
 */
import {
  copilotMutationParamSchemas,
  parseReferences,
  type CopilotMutationParams,
  type CopilotMutationTool,
} from "@invisible-string/shared";

import type { WorkspaceInventory } from "./inventory";

export type MutationValidation =
  | {
      ok: true;
      tool: CopilotMutationTool;
      params: CopilotMutationParams[CopilotMutationTool];
    }
  | { ok: false; message: string };

function invalid(message: string): MutationValidation {
  return { ok: false, message };
}

export function isMutationTool(name: string): name is CopilotMutationTool {
  return name in copilotMutationParamSchemas;
}

/**
 * Validate a raw model tool call. Returns parsed params on success or a
 * model-facing error message describing how to fix the call.
 */
export function validateMutation(
  toolName: string,
  input: unknown,
  inventory: WorkspaceInventory,
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
      if (!pool.some((item) => item.id === id)) {
        const known = pool
          .map((item) => `${item.id} (${item.name})`)
          .join(", ");
        return invalid(
          `${kind} id "${id}" does not exist in this workspace — known ${kind}s: ${known || "(none)"}`,
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
      for (const ref of parseReferences(markdown)) {
        if (ref.kind === "connection") {
          if (!inventory.connections.some((c) => c.slug === ref.name)) {
            problems.push(
              `"${ref.raw}" references an unknown connection (known: ${
                inventory.connections.map((c) => `@${c.slug}`).join(", ") || "(none)"
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
          }
        }
      }
      if (problems.length > 0) {
        return invalid(
          `instructions reference resources that do not exist: ${problems.join("; ")}. ` +
            "Only reference workspace connections/skills (and propose addContext for them first).",
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
