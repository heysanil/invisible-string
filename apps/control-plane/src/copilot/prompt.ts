/**
 * Copilot system prompt + tool specs. The prompt carries: the copilot role,
 * the CURRENT draft JSON, the workspace inventory (with the exact ids the
 * mutation tools accept), the @reference grammar, and strict instructions to
 * only propose changes via tools.
 */
import { z } from "zod";
import {
  copilotMutationParamSchemas,
  COPILOT_MUTATION_TOOLS,
  type CopilotMutationTool,
} from "@invisible-string/shared";

import type { WorkspaceInventory } from "./inventory";
import type { TransportToolSpec } from "./transport";

const TOOL_DESCRIPTIONS: Record<CopilotMutationTool, string> = {
  setTrigger:
    "Propose replacing the TRIGGER pillar with a complete trigger config (manual | form | webhook | slack | schedule).",
  addContext:
    "Propose attaching an existing workspace MCP connection or skill (by its exact id from the inventory) to the CONTEXT pillar.",
  removeContext:
    "Propose detaching an MCP connection or skill from the CONTEXT pillar.",
  setAgent:
    "Propose updating the AGENT pillar: agent preset id, reasoning effort, and/or an allowlisted specific model id.",
  setModelPreset:
    "Propose re-pointing the workflow's model preset override (powerful | balanced | quick).",
  setInstructions:
    "Propose replacing the INSTRUCTIONS pillar markdown wholesale. Use @references only for attached/available resources.",
};

/** JSON-schema tool specs derived from the shared zod schemas. */
export function buildToolSpecs(): TransportToolSpec[] {
  return COPILOT_MUTATION_TOOLS.map((tool) => {
    const inputSchema = z.toJSONSchema(copilotMutationParamSchemas[tool], {
      io: "input",
      target: "draft-7",
    }) as Record<string, unknown>;
    // Every tool also takes a short user-facing rationale, shown on the
    // suggestion card (stripped before schema validation of the params).
    const properties = inputSchema.properties as
      | Record<string, unknown>
      | undefined;
    if (properties) {
      properties.rationale = {
        type: "string",
        description:
          "One short sentence shown to the user explaining why you propose this change.",
      };
    }
    return { name: tool, description: TOOL_DESCRIPTIONS[tool], inputSchema };
  });
}

/**
 * Workspace-controlled text (connection/skill names + descriptions come from
 * registry metadata or user input) is rendered into STRUCTURED inventory
 * lines — flatten newlines and double quotes so hostile content cannot forge
 * extra inventory lines or break the `name="…"` framing. Injection through
 * these fields is already neutralized downstream (validate.ts checks ids
 * against the inventory OBJECTS, never the prompt string), this just stops
 * the prompt itself from being visually spoofable.
 */
function promptSafe(text: string, maxLength = 300): string {
  const flat = text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

export function buildSystemPrompt(opts: {
  draft: Record<string, unknown>;
  inventory: WorkspaceInventory;
}): string {
  const { draft, inventory } = opts;
  const connections = inventory.connections
    .map(
      (c) =>
        `- id=${c.id} name="${promptSafe(c.name)}" ref=@${c.slug}${c.enabled ? "" : " (disabled)"}${c.description ? ` — ${promptSafe(c.description)}` : ""}`,
    )
    .join("\n");
  const skills = inventory.skills
    .map(
      (s) =>
        `- id=${s.id} name="${promptSafe(s.name)}" ref=@skill.${s.slug}${s.description ? ` — ${promptSafe(s.description)}` : ""}`,
    )
    .join("\n");
  const agents = inventory.agentPresets
    .map(
      (a) =>
        `- id=${a.id} name="${promptSafe(a.name)}" reasoning=${a.reasoningEffort}${a.modelPreset ? ` preset=${a.modelPreset}` : ""}${a.modelId ? ` model=${a.modelId}` : ""}${a.description ? ` — ${promptSafe(a.description)}` : ""}`,
    )
    .join("\n");
  const presets = inventory.modelPresets
    .map((p) => `- ${p.slug} → ${p.provider}/${p.modelId}`)
    .join("\n");
  const allowlist = inventory.allowlist
    .filter((entry) => entry.enabled)
    .map((entry) => `- ${entry.modelId} (${entry.provider})`)
    .join("\n");

  return `You are the workflow copilot for invisible-string, docked in the workflow builder. \
Workflows have four pillars: TRIGGER (how a run starts), CONTEXT (attached MCP connections and skills), \
AGENT (agent preset + model), INSTRUCTIONS (markdown the agent follows, with inline @references).

## Current draft (JSON)
${JSON.stringify(draft, null, 2)}

## Workspace inventory
MCP connections:
${connections || "(none)"}
Skills:
${skills || "(none)"}
Agent presets:
${agents || "(none)"}
Model presets:
${presets || "(none)"}
Allowlisted models:
${allowlist || "(none)"}

## @reference grammar (inside instructions markdown)
- \`@trigger.<path>\` — a dot path into the trigger event data (e.g. @trigger.email.subject; form field keys become @trigger.<key>).
- \`@<connection-slug>\` — an attached MCP connection (slugs listed above).
- \`@skill.<slug>\` — an attached skill (slugs listed above).
References must start with a letter; segments are letters/digits/_/-.

## Hard rules
1. You NEVER edit the draft yourself. Every change must be proposed through exactly one of the mutation tools; the user previews and accepts or rejects each proposal in the builder.
2. Each tool result tells you whether the user accepted or rejected the proposal — adapt to rejections instead of re-proposing the same thing.
3. Use only ids/slugs from the inventory above. Never invent connections, skills, agent presets, or model ids.
4. Keep instructions markdown consistent with attached context: do not @reference a connection or skill that is not attached to the CONTEXT pillar — propose addContext for it first, then setInstructions.
5. Only models on the allowlist may be set via setAgent.modelId; prefer setModelPreset (powerful/balanced/quick) unless a specific model is required.
6. Keep the prose you stream to the user short — the proposals carry the substance. When the request is ambiguous, ask instead of guessing.`;
}
