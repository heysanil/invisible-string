/**
 * AGENT-surface copilot adapter (see adapter.ts for the seam).
 *
 * Maps the agent toolset (`setName` / `setDescription` / `setPersona` /
 * `setModel` / `addContext` / `removeContext`) onto the agent editor reducer
 * actions (single writer — the same path manual edits take). `setPersona`
 * previews as a full DiffView diff (persona is a document, like workflow
 * instructions); the rest get the compact before→after row.
 *
 * IDENTITY IS NOT IN THE DRAFT (2026-08-11 spec D7.3/D7.4). `agents.name` and
 * `agents.description` are row columns, not part of the compiled
 * {@link AgentDefinition}, so:
 * - the card's "before" side comes from {@link AgentCopilotAdapterOptions.getIdentity},
 *   not from `getDraft()`;
 * - `setDescription` still rides the editor reducer (it owns the column);
 * - `setName` does NOT — the reducer deliberately excludes the name ("the
 *   header commits it directly", lib/agents/model.ts), so it rides its own
 *   {@link AgentCopilotAdapterOptions.setName} seam, which the owning screen
 *   points at the same commit path its header uses.
 */
import { AlignLeft, Cpu, FileText, Plug, Tag } from "lucide-react";
import {
  AGENT_COPILOT_MUTATION_TOOLS,
  type AgentCopilotMutationTool,
  type AgentDefinition,
  type AgentModel,
  type CopilotProposal,
  type ReasoningEffort,
} from "@invisible-string/shared";

import type { AgentEditorAction, AgentSection } from "../agents/model";
import type { ContextResources } from "../builder/resources";
import { shortModelId } from "../builder/summary";
import type { CopilotSurfaceAdapter, ProposalDescription } from "./adapter";
import { unsupportedProposalDescription } from "./mutations";

/** Proposals belonging to the agent surface (any other tool = server bug). */
export type AgentCopilotProposal = Extract<
  CopilotProposal,
  { tool: AgentCopilotMutationTool }
>;

export function isAgentProposal(
  proposal: CopilotProposal,
): proposal is AgentCopilotProposal {
  return (AGENT_COPILOT_MUTATION_TOOLS as readonly string[]).includes(
    proposal.tool,
  );
}

/** Row-level agent identity — the "before" side of the two identity cards. */
export interface AgentIdentity {
  name: string;
  description: string | null;
}

/**
 * The editor section a proposal lands on (rail flash + card icon). The
 * copilot never touches "access" — run-as is a human trust decision.
 *
 * `null` for the identity tools: name and description live in the editor
 * HEADER, not in any of the four rail sections, and flashing an unrelated
 * section would point the user at the wrong thing.
 */
export function agentSectionOfProposal(
  proposal: AgentCopilotProposal,
): AgentSection | null {
  switch (proposal.tool) {
    case "setName":
    case "setDescription":
      return null;
    case "setPersona":
      return "persona";
    case "setModel":
      return "model";
    case "addContext":
    case "removeContext":
      return "context";
  }
}

/**
 * Map an agent proposal to the editor reducer actions that apply it.
 *
 * `setName` maps to NO action on purpose (see the module header) — the adapter
 * routes it through its own seam. Everything else is a reducer action.
 */
export function agentProposalToActions(
  proposal: AgentCopilotProposal,
): AgentEditorAction[] {
  switch (proposal.tool) {
    case "setName":
      return [];
    case "setDescription":
      return [
        { type: "setDescription", description: proposal.params.description },
      ];
    case "setPersona":
      return [{ type: "setPersona", markdown: proposal.params.markdown }];
    case "setModel": {
      // Fan out to one action per provided field (the schema guarantees at
      // least one) — untouched fields keep their current values.
      const { preset, modelId, reasoning } = proposal.params;
      const actions: AgentEditorAction[] = [];
      if (preset !== undefined) actions.push({ type: "setModelPreset", preset });
      if (modelId !== undefined) actions.push({ type: "setModelId", modelId });
      if (reasoning !== undefined) {
        // Three-valued on the wire: `null` is the copilot ASKING to go back to
        // inheriting, which the reducer spells as a cleared override.
        actions.push({
          type: "setReasoning",
          reasoning: reasoning ?? undefined,
        });
      }
      return actions;
    }
    case "addContext":
      return [
        proposal.params.kind === "connection"
          ? { type: "addConnection", id: proposal.params.id }
          : { type: "addSkill", id: proposal.params.id },
      ];
    case "removeContext":
      return [
        proposal.params.kind === "connection"
          ? { type: "removeConnection", id: proposal.params.id }
          : { type: "removeSkill", id: proposal.params.id },
      ];
  }
}

// ── Descriptions ─────────────────────────────────────────────────────────────

function contextName(
  params: { kind: "connection" | "skill"; id: string },
  resources: ContextResources,
): string {
  if (params.kind === "connection") {
    return resources.connectionById.get(params.id)?.name ?? params.id;
  }
  return resources.skillById.get(params.id)?.name ?? params.id;
}

function sourceCount(count: number): string {
  return `${count} source${count === 1 ? "" : "s"}`;
}

/**
 * How an effort reads in a proposal card. `undefined`/`null` are NOT missing
 * data — they are the inherit signal (the preset's effort, or the model's own
 * default under an override), and must never render as "undefined".
 */
function reasoningWord(effort: ReasoningEffort | null | undefined): string {
  return effort ?? "inherited";
}

/** Compact one-liner for the current model block, e.g. "balanced · reasoning max". */
function modelLine(model: AgentModel): string {
  const base = model.modelId
    ? `override → ${shortModelId(model.modelId)}`
    : model.preset;
  return `${base} · reasoning ${reasoningWord(model.reasoning)}`;
}

export function describeAgentProposal(
  proposal: AgentCopilotProposal,
  definition: AgentDefinition,
  resources: ContextResources,
  /**
   * Current row identity. Optional so a caller with no identity source still
   * gets a usable card — the before side then reads as unknown rather than
   * as a fabricated empty value.
   */
  identity?: AgentIdentity,
): ProposalDescription {
  switch (proposal.tool) {
    case "setName": {
      const before = identity?.name.trim() ?? "";
      return {
        icon: Tag,
        title: `Rename agent: ${proposal.params.name}`,
        before: before.length > 0 ? before : null,
        after: proposal.params.name,
      };
    }
    case "setDescription": {
      const before = identity?.description?.trim() ?? "";
      return {
        icon: AlignLeft,
        title: before.length > 0 ? "Update description" : "Add description",
        // An agent that has none is a real state, not missing data — say so
        // rather than rendering an empty strikethrough.
        before: before.length > 0 ? before : "No description",
        after: proposal.params.description,
      };
    }
    case "setPersona": {
      const before = definition.persona;
      return {
        icon: FileText,
        title:
          before.trim().length === 0 ? "Write persona" : "Rewrite persona",
        before: null, // the diff carries the preview
        after: null,
        diff: { before, after: proposal.params.markdown },
      };
    }
    case "setModel": {
      const { preset, modelId, reasoning } = proposal.params;
      const parts: string[] = [];
      if (preset !== undefined) parts.push(`preset ${preset}`);
      if (modelId !== undefined) parts.push(`model ${shortModelId(modelId)}`);
      if (reasoning !== undefined) {
        parts.push(`reasoning ${reasoningWord(reasoning)}`);
      }
      return {
        icon: Cpu,
        title: `Set model: ${parts.join(" · ")}`,
        before: modelLine(definition.model),
        after: parts.join(" · "),
      };
    }
    case "addContext": {
      const name = contextName(proposal.params, resources);
      const count =
        definition.context.mcpConnectionIds.length +
        definition.context.skillIds.length;
      return {
        icon: Plug,
        title: `Add ${proposal.params.kind}: ${name}`,
        before: sourceCount(count),
        after: `${sourceCount(count + 1)} — + ${name}`,
      };
    }
    case "removeContext": {
      const name = contextName(proposal.params, resources);
      const count =
        definition.context.mcpConnectionIds.length +
        definition.context.skillIds.length;
      return {
        icon: Plug,
        title: `Remove ${proposal.params.kind}: ${name}`,
        before: sourceCount(count),
        after: `${sourceCount(Math.max(0, count - 1))} — − ${name}`,
      };
    }
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────

const SCAFFOLD_PROMPTS = [
  "Draft a persona for an executive assistant",
  "Attach the right tools for email and calendar",
  "Name this agent and write its one-line description",
] as const;

const REFINE_PROMPTS = [
  "Tighten the persona",
  "Explain this agent's issues",
] as const;

export interface AgentCopilotAdapterOptions {
  agentId: string;
  /** Must read the LIVE draft (a ref-backed closure, never a stale capture). */
  getDraft: () => AgentDefinition;
  /**
   * Must read the LIVE row identity (name + description), same discipline as
   * {@link getDraft}. Only the two identity CARDS need it, so it is optional —
   * without it they render with an unknown "before" side.
   */
  getIdentity?: () => AgentIdentity;
  /** The agent editor controller's dispatch (single writer). */
  dispatch: (action: AgentEditorAction) => void;
  /**
   * Commits an accepted `setName` (spec D7.3). Separate from `dispatch`
   * because the agent NAME is not part of the editor reducer — the screen's
   * header owns it and PATCHes it directly, and this must take that exact
   * path so the two writers cannot disagree.
   *
   * Optional only so the seam can be added without breaking construction:
   * when it is absent the copilot's rename cards render but cannot apply, so
   * a screen that exposes the agent surface MUST wire it.
   */
  setName?: (name: string) => void;
  /** Merged workspace+user resources (resolves context ids to names). */
  resources: ContextResources;
  /** Fired after an accepted proposal is applied (rail section flash). */
  onApplied?: (section: AgentSection) => void;
}

export function agentCopilotAdapter(
  options: AgentCopilotAdapterOptions,
): CopilotSurfaceAdapter<AgentDefinition> {
  const { agentId, getDraft, getIdentity, dispatch, setName, resources, onApplied } =
    options;
  return {
    entityRef: { surface: "agent", entityId: agentId },
    getDraft,
    applyProposal: (proposal) => {
      if (!isAgentProposal(proposal)) return;
      if (proposal.tool === "setName") setName?.(proposal.params.name);
      for (const action of agentProposalToActions(proposal)) dispatch(action);
      // Identity proposals have no rail section (see agentSectionOfProposal).
      const section = agentSectionOfProposal(proposal);
      if (section !== null) onApplied?.(section);
    },
    describeProposal: (proposal) =>
      isAgentProposal(proposal)
        ? describeAgentProposal(proposal, getDraft(), resources, getIdentity?.())
        : unsupportedProposalDescription(proposal),
    emptyStateCopy: {
      title: "Shape this agent with copilot",
      description:
        "Describe the agent you're building — persona, model and tool suggestions land as Apply/Preview cards you can accept one by one.",
    },
    promptChips: () => {
      const draft = getDraft();
      const untouched =
        draft.persona.trim().length === 0 &&
        draft.context.mcpConnectionIds.length === 0 &&
        draft.context.skillIds.length === 0;
      return untouched ? SCAFFOLD_PROMPTS : REFINE_PROMPTS;
    },
  };
}
