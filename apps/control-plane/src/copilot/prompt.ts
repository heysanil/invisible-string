/**
 * Copilot system prompt + tool specs, per surface (design §5.7). Each
 * `user_message` names its surface — "workflow" (trigger → pick agent →
 * write instructions) or "agent" (persona/model/context editing) — and gets
 * the matching toolset and prompt. Both prompts carry: the copilot role, the
 * CURRENT draft JSON, the workspace inventory (with the exact ids the
 * mutation tools accept), the @reference grammar, and strict instructions to
 * only propose changes via tools. The agent prompt additionally carries the
 * agent's IDENTITY (name + one-line description, spec D7.3/D7.4) when the
 * editor puts it on the draft — those live on the `agents` row rather than in
 * the definition, so they arrive alongside it, not inside it.
 */
import { z } from "zod";
import {
  AGENT_COPILOT_MUTATION_TOOLS,
  copilotMutationParamSchemas,
  WORKFLOW_COPILOT_MUTATION_TOOLS,
  type CopilotMutationTool,
  type CopilotSurface,
} from "@invisible-string/shared";

import type { WorkspaceInventory } from "./inventory";
import type { TransportToolSpec } from "./transport";

const TOOL_DESCRIPTIONS: Record<CopilotMutationTool, string> = {
  // workflow surface
  setTrigger:
    "Propose replacing the workflow's TRIGGER with a complete trigger config (manual | form | webhook | slack | schedule).",
  setAgent:
    "Propose pointing the workflow at a PUBLISHED agent (by its exact id from the inventory) to handle every run.",
  setInstructions:
    "Propose replacing the workflow's INSTRUCTIONS markdown wholesale. Use @references only for valid trigger paths and the selected agent's published context.",
  // agent surface
  setName:
    "Propose renaming the agent (1–120 characters; keep it to a few words). Use it when the user asks for a name, or when the agent still carries a placeholder name like \"Untitled agent\" and the conversation has made its purpose clear. Duplicate names are allowed in a workspace, so a name never has to be refused for being taken.",
  setDescription:
    "Propose the agent's one-line description (max 200 characters, a single line) — the summary shown on agent cards and in the editor header. Say what the agent DOES for the workspace, in one sentence; never restate the persona.",
  setPersona:
    "Propose replacing the agent's PERSONA markdown wholesale. @reference only context attached to this agent; @trigger paths are not allowed in personas.",
  setModel:
    "Propose updating the agent's MODEL: preset (powerful | balanced | quick), reasoning effort, and/or an allowlisted specific model id — at least one field. Reasoning is INHERITED by default: pass null to clear an override and go back to inheriting (the preset's effort, or the model's own default behind a specific-model override); omit the field to leave the current setting alone; pass a level only when the user wants an explicit one, and only a level that model supports.",
  addContext:
    "Propose attaching an existing workspace MCP connection or skill (by its exact id from the inventory) to the agent's CONTEXT.",
  removeContext:
    "Propose detaching an MCP connection or skill from the agent's CONTEXT.",
};

/** JSON-schema tool specs for the surface's toolset (shared zod schemas). */
export function buildToolSpecs(surface: CopilotSurface): TransportToolSpec[] {
  const tools: readonly CopilotMutationTool[] =
    surface === "workflow"
      ? WORKFLOW_COPILOT_MUTATION_TOOLS
      : AGENT_COPILOT_MUTATION_TOOLS;
  return tools.map((tool) => {
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
 * Workspace-controlled text (connection/skill/agent names + descriptions come
 * from registry metadata or user input) is rendered into STRUCTURED inventory
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
  surface: CopilotSurface;
  draft: Record<string, unknown>;
  inventory: WorkspaceInventory;
}): string {
  return opts.surface === "workflow"
    ? buildWorkflowSystemPrompt(opts.draft, opts.inventory)
    : buildAgentSystemPrompt(opts.draft, opts.inventory);
}

// ── workflow surface ─────────────────────────────────────────────────────────

function buildWorkflowSystemPrompt(
  draft: Record<string, unknown>,
  inventory: WorkspaceInventory,
): string {
  const agents = inventory.agents
    .map((agent) => {
      const context = [
        ...agent.contextConnectionSlugs.map((slug) => `@${slug}`),
        ...agent.contextSkillSlugs.map((slug) => `@skill.${slug}`),
      ];
      const status = agent.published
        ? ` published context=[${context.join(", ") || "(none)"}]`
        : " NOT PUBLISHED (cannot be selected until published)";
      return `- id=${agent.id} name="${promptSafe(agent.name)}"${status}${agent.description ? ` — ${promptSafe(agent.description)}` : ""}`;
    })
    .join("\n");

  return `You are the workflow copilot for invisible-string, docked in the workflow builder. \
A workflow is a standing delegation with three sections: TRIGGER (how a run starts), \
AGENT (the published agent that handles each run), INSTRUCTIONS (markdown rendered into \
the agent's task message at dispatch, with inline @references). The usual build order: \
set the trigger, pick a published agent, then write the instructions.

## Current draft (JSON)
${JSON.stringify(draft, null, 2)}

## Workspace agents (select with setAgent by id)
${agents || "(none — the user must create and publish an agent first)"}

## @reference grammar (inside instructions markdown)
- \`@trigger.<path>\` — a dot path into the trigger event data (e.g. @trigger.email.subject; form field keys become @trigger.<key>). Only form/webhook/slack triggers carry dispatch data.
- \`@<connection-slug>\` / \`@skill.<slug>\` — context equipped on the SELECTED agent; each agent's published context slugs are listed above.
References must start with a letter; segments are letters/digits/_/-.

## Hard rules
1. You NEVER edit the draft yourself. Every change must be proposed through exactly one of the mutation tools; the user previews and accepts or rejects each proposal in the builder.
2. Each tool result tells you whether the user accepted or rejected the proposal — adapt to rejections instead of re-proposing the same thing.
3. Use only ids from the inventory above; never invent agents. Only PUBLISHED agents may be set via setAgent. Agent NAMES are not unique in a workspace — two agents may share one exactly — so the id is the only way to name one; if the user's wording matches several, ask which they mean instead of picking.
4. Keep instructions consistent with the selected agent: only @reference connections/skills in ITS published context (propose setAgent first when the draft has no agent), and only @trigger paths legal for the draft's trigger type.
5. Keep the prose you stream to the user short — the proposals carry the substance. When the request is ambiguous, ask instead of guessing.`;
}

// ── agent surface ────────────────────────────────────────────────────────────

function buildAgentSystemPrompt(
  draft: Record<string, unknown>,
  inventory: WorkspaceInventory,
): string {
  const connections = inventory.connections
    .map((c) => {
      // Cached tool names (bare, loader-capped); the marker carries the count
      // the cap cut so the model knows the list is not exhaustive.
      const names = c.tools.map((tool) => promptSafe(tool, 80));
      const truncated = c.toolCount - c.tools.length;
      const toolsClause =
        names.length === 0
          ? ""
          : ` tools=[${names.join(", ")}${truncated > 0 ? `, …+${truncated} more` : ""}]`;
      return `- id=${c.id} name="${promptSafe(c.name)}" ref=@${c.slug} health=${c.health}${c.enabled ? "" : " (disabled)"}${toolsClause}${c.description ? ` — ${promptSafe(c.description)}` : ""}`;
    })
    .join("\n");
  const skills = inventory.skills
    .map(
      (s) =>
        `- id=${s.id} name="${promptSafe(s.name)}" ref=@skill.${s.slug}${s.description ? ` — ${promptSafe(s.description)}` : ""}`,
    )
    .join("\n");
  const presets = inventory.modelPresets
    .map(
      (p) =>
        `- ${p.slug} → ${p.provider}/${p.modelId}, reasoning ${p.reasoning} (inherited by agents on this preset)`,
    )
    .join("\n");
  // `supportedEfforts: null` is UNKNOWN, not "none" — say so, so the model
  // does not read a missing list as "this model takes no effort at all".
  const allowlist = inventory.allowlist
    .filter((entry) => entry.enabled)
    .map(
      (entry) =>
        `- ${entry.modelId} (${entry.provider}) efforts: ${
          entry.supportedEfforts === null
            ? "unknown"
            : entry.supportedEfforts.join(", ") || "none advertised"
        }`,
    )
    .join("\n");

  // IDENTITY (name + description) lives on the `agents` row, not in the
  // definition, so it only reaches the prompt if the editor put it on the
  // draft. Rendered only when present — inventing a "(unknown)" line would
  // invite the model to "fix" a name it cannot actually see.
  const name =
    typeof draft.name === "string" && draft.name.trim()
      ? promptSafe(draft.name, 120)
      : null;
  const description =
    typeof draft.description === "string" && draft.description.trim()
      ? promptSafe(draft.description)
      : null;
  // The description line is worth stating as "(none yet)" — that absence is
  // itself a prompt to write one — but only once the editor has proven it
  // sends identity at all, which the name does.
  const identity =
    name === null
      ? ""
      : `Name: "${name}"\nDescription: ${description ?? "(none yet)"}`;

  return `You are the agent copilot for invisible-string, docked in the agent editor. \
An agent has three parts: PERSONA (markdown identity and standing behavior), MODEL \
(workspace preset or allowlisted specific model, plus reasoning effort), CONTEXT \
(attached MCP connections and skills). It also carries a NAME and a one-line \
DESCRIPTION, which you may propose with setName/setDescription. Published agents \
handle chat directly and are delegated to by workflows.
${identity ? `\n## This agent\n${identity}\n` : ""}
## Current draft (JSON)
${JSON.stringify(draft, null, 2)}

## Workspace inventory
MCP connections:
${connections || "(none)"}
Skills:
${skills || "(none)"}
Model presets:
${presets || "(none)"}
Allowlisted models:
${allowlist || "(none)"}

## @reference grammar (inside persona markdown)
- \`@<connection-slug>\` — an ATTACHED MCP connection (slugs listed above).
- \`@skill.<slug>\` — an ATTACHED skill (slugs listed above).
- \`@trigger.*\` is NOT allowed in personas — trigger data exists only in workflow instructions.
References must start with a letter; segments are letters/digits/_/-.

## Hard rules
1. You NEVER edit the draft yourself. Every change must be proposed through exactly one of the mutation tools; the user previews and accepts or rejects each proposal in the editor.
2. Each tool result tells you whether the user accepted or rejected the proposal — adapt to rejections instead of re-proposing the same thing.
3. Use only ids/slugs from the inventory above. Never invent connections, skills, or model ids; when a connection lists tools=[…], those are its real callable tool names — never invent others.
4. Keep the persona consistent with attached context: do not @reference a connection or skill that is not attached to the CONTEXT — propose addContext for it first, then setPersona.
5. Only models on the allowlist may be set via setModel.modelId; prefer a preset (powerful/balanced/quick) unless a specific model is required.
6. Reasoning effort is inherited unless the draft sets one. Leave it inherited unless the user asks for a specific level; propose only an effort the effective model lists above ("unknown" means any level is acceptable), and use "provider-default" for "send no reasoning setting at all".
7. Name and description are the agent's IDENTITY, not its behavior: propose setName/setDescription when the user asks, or once when a placeholder name like "Untitled agent" still stands and the agent's purpose has become clear — then leave them alone. Never re-propose a name or description the agent already has, and never use them to restate the persona.
8. Keep the prose you stream to the user short — the proposals carry the substance. When the request is ambiguous, ask instead of guessing.`;
}
