/**
 * Copilot system prompt + tool specs, per surface (design §5.7, pipelines
 * redesign). Each `user_message` names its surface — "workflow" (the pipeline
 * builder: trigger + step tree) or "agent" (persona/model/context editing) —
 * and gets the matching toolset and prompt. Both prompts carry: the copilot
 * role, the CURRENT draft JSON, the workspace inventory (with the exact ids
 * the mutation tools accept), the @reference grammar, and strict instructions
 * to only propose changes via tools.
 *
 * The workflow surface additionally exposes the READ tools
 * (searchConnectionTools/getConnectionTool, executed inline server-side) and
 * keeps tool DETAIL out of the prompt on purpose: connections render as an
 * INDEX (id/slug/health/capped tool names) and the hard rules force a search
 * before any tool-step proposal — never invented tool names, never invented
 * step ids.
 *
 * The agent prompt additionally carries the agent's IDENTITY (name + one-line
 * description, spec D7.3/D7.4) — those live on the `agents` row rather than
 * in the definition, so they arrive ALONGSIDE the draft in the frame's own
 * `identity` field (never inside `draft`, which is an `AgentDefinition` and
 * has no such keys), resolved by the plugin to the editor's live values or,
 * failing that, the persisted row.
 */
import { z } from "zod";
import {
  AGENT_COPILOT_MUTATION_TOOLS,
  copilotMutationParamSchemas,
  WORKFLOW_COPILOT_MUTATION_TOOLS,
  WORKFLOW_COPILOT_READ_TOOLS,
  workflowCopilotReadParamSchemas,
  type CopilotAgentIdentity,
  type CopilotMutationTool,
  type CopilotSurface,
  type WorkflowCopilotReadTool,
} from "@invisible-string/shared";

import type { WorkspaceInventory } from "./inventory";
import type { TransportToolSpec } from "./transport";

const TOOL_DESCRIPTIONS: Record<
  CopilotMutationTool | WorkflowCopilotReadTool,
  string
> = {
  // workflow surface — mutations
  setTrigger:
    "Propose replacing the workflow's TRIGGER with a complete trigger config (manual | form | webhook | slack | schedule).",
  addStep:
    "Propose inserting ONE new pipeline step. Step ids are MINTED SERVER-SIDE — any `id` you write here is replaced, so use any placeholder matching the pattern and never reference it again. Give the step a short unique slug (its @steps handle). position: {after: <existing stepId> | null, parent?: {stepId, slot}} — `after: null` is the head of the target list; omit `parent` for the top level; slot `body` = a for_each's steps, `then`/`else` = branch lanes (the lane resolves from `after`).",
  updateStep:
    "Propose replacing an EXISTING step wholesale, named by its exact stepId from the current draft. Re-emit the complete step (every field you want kept); the step keeps its id — a replacement may rename its slug but never re-identify it.",
  removeStep:
    "Propose deleting a step by its exact stepId (containers lose their whole subtree). If later steps reference its slug, fix them too.",
  moveStep:
    "Propose relocating an existing step (subtree and all) to a new position (same position shape as addStep). @steps references must still point at PRECEDING steps after the move.",
  // workflow surface — read tools (executed inline, never a proposal card)
  searchConnectionTools:
    "Search the workspace connections' cached MCP tool lists (ranked matches, capped). ALWAYS call this before proposing a tool step — never invent tool names. An empty query with a connectionId browses that connection's tools.",
  getConnectionTool:
    "Fetch one cached tool's detail — description, parameter names, and the tool's input JSON schema when the probe cached one. Call it before shaping a tool step's args so parameter names are never guessed.",
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

/**
 * JSON-schema tool specs for the surface's toolset (shared zod schemas). The
 * workflow surface exposes its mutation tools PLUS the two read tools; only
 * mutation tools take the user-facing `rationale` (read tools produce no
 * suggestion card to print it on).
 */
export function buildToolSpecs(surface: CopilotSurface): TransportToolSpec[] {
  const mutationTools: readonly CopilotMutationTool[] =
    surface === "workflow"
      ? WORKFLOW_COPILOT_MUTATION_TOOLS
      : AGENT_COPILOT_MUTATION_TOOLS;
  const specs: TransportToolSpec[] = mutationTools.map((tool) => {
    const inputSchema = z.toJSONSchema(copilotMutationParamSchemas[tool], {
      io: "input",
      target: "draft-7",
    }) as Record<string, unknown>;
    // Every mutation tool also takes a short user-facing rationale, shown on
    // the suggestion card (stripped before schema validation of the params).
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
  if (surface === "workflow") {
    for (const tool of WORKFLOW_COPILOT_READ_TOOLS) {
      specs.push({
        name: tool,
        description: TOOL_DESCRIPTIONS[tool],
        inputSchema: z.toJSONSchema(workflowCopilotReadParamSchemas[tool], {
          io: "input",
          target: "draft-7",
        }) as Record<string, unknown>,
      });
    }
  }
  return specs;
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

/**
 * One connection INDEX line: id/slug/health, the loader-capped bare tool
 * names (the truncation marker carries the count the cap cut), and — on the
 * workflow surface — a user-scope marker, since tool steps demand workspace
 * connections. Detail beyond the names lives behind the read tools.
 */
function connectionLine(
  c: WorkspaceInventory["connections"][number],
  opts: { markUserScope: boolean },
): string {
  const names = c.tools.map((tool) => promptSafe(tool, 80));
  const truncated = c.toolCount - c.tools.length;
  const toolsClause =
    names.length === 0
      ? ""
      : ` tools=[${names.join(", ")}${truncated > 0 ? `, …+${truncated} more` : ""}]`;
  const scopeClause =
    opts.markUserScope && c.scope === "user"
      ? " (user-scoped — NOT usable in tool steps)"
      : "";
  return `- id=${c.id} name="${promptSafe(c.name)}" ref=@${c.slug} health=${c.health}${c.enabled ? "" : " (disabled)"}${scopeClause}${toolsClause}${c.description ? ` — ${promptSafe(c.description)}` : ""}`;
}

export function buildSystemPrompt(opts: {
  surface: CopilotSurface;
  draft: Record<string, unknown>;
  inventory: WorkspaceInventory;
  /**
   * Agent-surface row identity (spec D7.3/D7.4). Null/omitted renders NO
   * identity section — the workflow surface has none, and inventing a blank
   * one would invite the model to "fix" a name it cannot actually see.
   */
  identity?: CopilotAgentIdentity | null;
}): string {
  return opts.surface === "workflow"
    ? buildWorkflowSystemPrompt(opts.draft, opts.inventory)
    : buildAgentSystemPrompt(opts.draft, opts.inventory, opts.identity ?? null);
}

// ── workflow surface ─────────────────────────────────────────────────────────

function buildWorkflowSystemPrompt(
  draft: Record<string, unknown>,
  inventory: WorkspaceInventory,
): string {
  const connections = inventory.connections
    .map((c) => connectionLine(c, { markUserScope: true }))
    .join("\n");
  const agents = inventory.agents
    .map((agent) => {
      const context = [
        ...agent.contextConnectionSlugs.map((slug) => `@${slug}`),
        ...agent.contextSkillSlugs.map((slug) => `@skill.${slug}`),
      ];
      const status = agent.published
        ? ` published context=[${context.join(", ") || "(none)"}]`
        : " NOT PUBLISHED (cannot handle workflow runs until published)";
      return `- id=${agent.id} name="${promptSafe(agent.name)}"${status}${agent.description ? ` — ${promptSafe(agent.description)}` : ""}`;
    })
    .join("\n");
  const presets = inventory.modelPresets
    .map((p) => `- ${p.slug} → ${p.provider}/${p.modelId}, reasoning ${p.reasoning}`)
    .join("\n");

  return `You are the workflow copilot for invisible-string, docked in the workflow builder. \
A workflow is a standing PIPELINE the control plane interprets: a TRIGGER (how a run starts) \
followed by STEPS executed in order. The draft below is the pipeline JSON \
({version: 2, trigger, steps, …}). Step kinds:
- tool — a deterministic MCP tool call on a workspace connection ({connectionId, tool, args})
- infer — a cheap direct model call on a workspace preset ({preset, prompt: {markdown}, output?.schema for structured output})
- agent — a full session with a PUBLISHED agent, run as a child run ({agentId, instructions: {markdown}, session: "fresh"|"thread"})
- for_each — run nested steps once per item of an array ({items: {"$ref": …}, steps}); loops cannot nest
- branch — the first lane whose \`when\` condition holds runs; \`else\` when none do
- filter — a gate ({where}): false at the top level skips the rest of the run; false inside a loop drops the item
- state — write persistent workflow state ({set}); read it back anywhere with @state.<key>

## Choosing a step kind
Always the CHEAPEST kind that suffices:
- a deterministic action whose args are knowable → tool (search the tool catalog first);
- a small transform, summary, classification or extraction over data already in scope → infer (declare output.schema when later steps need fields);
- open-ended judgment, multi-tool exploration, or conversation → agent.
Never spend an agent step on work a tool or infer step can do.

## Current draft (pipeline JSON)
${JSON.stringify(draft, null, 2)}

## Workspace connections (for tool steps)
${connections || "(none — the user must add a connection before tool steps can run)"}
This is an INDEX: tool name lists may be truncated and carry no detail. Use searchConnectionTools / getConnectionTool for real names, descriptions and arg schemas.

## Workspace agents (for agent steps)
${agents || "(none — the user must create and publish an agent before agent steps can run)"}

## Model presets (for infer steps)
${presets || "(none)"}

## References
Markdown surfaces (infer prompts, agent instructions, {"$tpl": "…"} strings) interpolate inline:
- \`@trigger.<path>\` — trigger event data (form field keys become @trigger.<key>). Only form/webhook/slack triggers carry dispatch data.
- \`@steps.<slug>.<path>\` — a PRECEDING step's output (tool: result/text; infer: text or the schema's fields; agent: result/text).
- \`@state.<key>\` — persistent workflow state.
- \`@item\` / \`@item.<path>\` — the current for_each item (loop bodies only).
- \`@now\` — the run's ISO timestamp.
References must start with a letter; segments are letters/digits/_/-.
Structured values (tool args, state.set, for_each.items, condition operands) use tagged JSON:
- {"$ref": "steps.<slug>.<path>"} — whole value, type preserved (heads: trigger / steps / state / item / now);
- {"$tpl": "text with @refs"} — string interpolation; bare strings stay literal.

## Hard rules
1. You NEVER edit the draft yourself. Every change must be proposed through exactly one of the mutation tools; the user previews and accepts or rejects each proposal in the builder.
2. Propose steps ONE PER CALL, in execution order. Each tool result tells you whether the user accepted or rejected the proposal — adapt to rejections instead of re-proposing the same thing.
3. NEVER invent MCP tool names: call searchConnectionTools before proposing a tool step (and getConnectionTool for the arg schema). Only use tool names those results — or the inventory above — actually list.
4. NEVER invent step ids: ids are minted server-side on addStep (an applied addStep's tool result hands you the new id), and you may reference existing steps only by ids present in the current draft or handed back by an applied addStep.
5. Use only ids from the inventory above: connections must be enabled and workspace-scoped for tool steps; agent steps need a PUBLISHED agent. Agent NAMES are not unique in a workspace — the id is the only way to name one; if the user's wording matches several, ask which they mean instead of picking.
6. Give every step a short unique slug — it is the @steps handle. @steps refs must name a PRECEDING step, and @item exists only inside for_each bodies.
7. Keep the prose you stream to the user short — the proposals carry the substance. When the request is ambiguous, ask instead of guessing.`;
}

// ── agent surface ────────────────────────────────────────────────────────────

function buildAgentSystemPrompt(
  draft: Record<string, unknown>,
  inventory: WorkspaceInventory,
  identityRow: CopilotAgentIdentity | null,
): string {
  const connections = inventory.connections
    .map((c) => connectionLine(c, { markUserScope: false }))
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
  // definition, so it reaches this function through its own argument — NEVER
  // off `draft`, which is an `AgentDefinition` and has no such keys (reading
  // it there is how the copilot ended up permanently blind to the agent's
  // name). Rendered only when a name resolved: inventing an "(unknown)" line
  // would invite the model to "fix" a name it cannot actually see.
  const name = identityRow?.name.trim()
    ? promptSafe(identityRow.name, 120)
    : null;
  const description = identityRow?.description?.trim()
    ? promptSafe(identityRow.description)
    : null;
  // The description line is worth stating as "(none yet)" — that absence is
  // itself a prompt to write one — but only once identity resolved at all,
  // which the name proves.
  const identity =
    name === null
      ? ""
      : `Name: "${name}"\nDescription: ${description ?? "(none yet)"}`;

  return `You are the agent copilot for invisible-string, docked in the agent editor. \
An agent has three parts: PERSONA (markdown identity and standing behavior), MODEL \
(workspace preset or allowlisted specific model, plus reasoning effort), CONTEXT \
(attached MCP connections and skills). It also carries a NAME and a one-line \
DESCRIPTION, which you may propose with setName/setDescription. Published agents \
handle chat directly and are delegated to by workflow agent steps.
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
- \`@trigger.*\` is NOT allowed in personas — trigger data exists only in workflow pipelines.
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
