/**
 * KEYED copilot smoke — the single real-model test (cost discipline).
 * Gated on COPILOT_KEYED=1 AND OPENROUTER_API_KEY; skips cleanly otherwise.
 *
 * Runs one turn (the Phase-4 acceptance one-liner, "triage form submissions
 * and draft replies") against a seeded fake workspace inventory through the
 * REAL OpenRouter transport, auto-accepts every proposal, APPLIES each one to
 * a draft the way the builder controller would, and asserts:
 * - the turn completes with ≥1 schema-valid setTrigger/setInstructions
 *   proposal (STRUCTURAL checks only — models drift, content is never pinned);
 * - the applied draft DRY-RUN-COMPILES CLEAN through the real compiler.
 */
import { describe, expect, test } from "bun:test";

import {
  compile,
  CompileError,
  RUNTIME_VERSIONS,
  type CompileDeps,
  type ResolvedMcpConnection,
  type ResolvedSkill,
} from "@invisible-string/compiler";
import {
  copilotMutationParamSchemas,
  type CopilotProposal,
  type CopilotServerFrame,
  type WorkflowDefinition,
} from "@invisible-string/shared";

import { loadCopilotConfig } from "./config";
import type { WorkspaceInventory } from "./inventory";
import { CopilotSession } from "./session";
import { createModelTransport } from "./transport";

const KEYED =
  process.env.COPILOT_KEYED === "1" && !!process.env.OPENROUTER_API_KEY;

const inventory: WorkspaceInventory = {
  connections: [
    {
      id: "bbbbbbbb-1111-4222-8333-444444444444",
      name: "Gmail",
      slug: "gmail",
      description: "reads the support inbox and sends drafts",
      enabled: true,
    },
  ],
  skills: [
    {
      id: "cccccccc-1111-4222-8333-444444444444",
      name: "Triage Guide",
      slug: "triage-guide",
      description: "how to classify and prioritize support requests",
    },
  ],
  agentPresets: [
    {
      id: "dddddddd-1111-4222-8333-444444444444",
      name: "Support Agent",
      description: "friendly support persona",
      reasoningEffort: "medium",
      modelPreset: "balanced",
      modelId: null,
    },
  ],
  modelPresets: [
    { slug: "powerful", provider: "openrouter", modelId: "anthropic/claude-opus-4.8" },
    { slug: "balanced", provider: "openrouter", modelId: "anthropic/claude-sonnet-5" },
    { slug: "quick", provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" },
  ],
  allowlist: [
    { provider: "openrouter", modelId: "anthropic/claude-sonnet-5", enabled: true },
    { provider: "openrouter", modelId: "anthropic/claude-haiku-4.5", enabled: true },
  ],
};

/** Apply an accepted proposal to the draft — mirrors the builder reducer. */
function applyProposal(draft: WorkflowDefinition, proposal: CopilotProposal): void {
  switch (proposal.tool) {
    case "setTrigger":
      draft.trigger = proposal.params.trigger;
      break;
    case "addContext": {
      const list =
        proposal.params.kind === "connection"
          ? draft.context.mcpConnectionIds
          : draft.context.skillIds;
      if (!list.includes(proposal.params.id)) list.push(proposal.params.id);
      break;
    }
    case "removeContext": {
      const { kind, id } = proposal.params;
      if (kind === "connection") {
        draft.context.mcpConnectionIds = draft.context.mcpConnectionIds.filter(
          (existing) => existing !== id,
        );
      } else {
        draft.context.skillIds = draft.context.skillIds.filter(
          (existing) => existing !== id,
        );
      }
      break;
    }
    case "setAgent":
      if (proposal.params.agentPresetId !== undefined) {
        draft.agent.agentPresetId = proposal.params.agentPresetId;
      }
      if (proposal.params.reasoning !== undefined) {
        draft.agent.reasoning = proposal.params.reasoning;
      }
      if (proposal.params.modelId !== undefined) {
        draft.agent.modelId = proposal.params.modelId;
      }
      break;
    case "setModelPreset":
      draft.agent.modelPreset = proposal.params.slug;
      break;
    case "setInstructions":
      draft.instructions.markdown = proposal.params.markdown;
      break;
  }
}

/** Resolve compile deps for the applied draft (what the control plane does). */
function compileDepsFor(draft: WorkflowDefinition): CompileDeps {
  const preset = inventory.agentPresets.find(
    (candidate) => candidate.id === draft.agent.agentPresetId,
  );
  const presetSlug = draft.agent.modelPreset ?? preset?.modelPreset ?? "balanced";
  const mapped = inventory.modelPresets.find((mp) => mp.slug === presetSlug);
  const modelId = draft.agent.modelId ?? mapped?.modelId ?? "anthropic/claude-sonnet-5";

  const connections: ResolvedMcpConnection[] = draft.context.mcpConnectionIds.map(
    (id) => {
      const row = inventory.connections.find((c) => c.id === id);
      return {
        id,
        slug: row?.slug ?? "unknown",
        url: "https://mcp.example.com/mcp",
        description: row?.description ?? "",
        auth: { kind: "none" },
        approval: { mode: "once" },
      };
    },
  );
  const skills: ResolvedSkill[] = draft.context.skillIds.map((id) => {
    const row = inventory.skills.find((s) => s.id === id);
    return {
      id,
      slug: row?.slug ?? "unknown",
      description: row?.description ?? "",
      markdown: `# ${row?.name ?? "Skill"}\n\n${row?.description ?? ""}\n`,
    };
  });

  return {
    versions: RUNTIME_VERSIONS,
    resolvedModel: { provider: "openrouter", modelId },
    workspaceSlug: "keyed-smoke",
    workflowSlug: "triage-form-submissions",
    agentPreset: {
      id: draft.agent.agentPresetId,
      name: preset?.name ?? "Support Agent",
      persona: preset?.description ?? "You are a helpful support agent.",
      defaultReasoning: "medium",
    },
    connections,
    skills,
  };
}

describe.skipIf(!KEYED)("copilot keyed smoke (real OpenRouter model)", () => {
  test(
    "the acceptance one-liner yields valid proposals whose applied draft dry-run-compiles clean",
    async () => {
      const config = loadCopilotConfig(process.env);
      const transport = createModelTransport(config, process.env);
      const frames: CopilotServerFrame[] = [];

      const draft: WorkflowDefinition = {
        trigger: { type: "manual" },
        context: { mcpConnectionIds: [], skillIds: [] },
        agent: { agentPresetId: inventory.agentPresets[0]!.id },
        instructions: { markdown: "Draft replies to each submission." },
      };

      const session = new CopilotSession({
        transport,
        config,
        send: (frame) => {
          frames.push(frame);
          // Auto-accept every proposal (Apply) so the loop runs to completion;
          // apply it to the draft exactly as the builder controller would.
          if (frame.type === "proposal") {
            applyProposal(draft, frame.proposal);
            queueMicrotask(() =>
              session.resolveMutation(frame.proposal.id, { outcome: "accepted" }),
            );
          }
        },
      });

      await session.runTurn({
        message: "triage form submissions and draft replies",
        draft: draft as unknown as Record<string, unknown>,
        inventory,
      });

      const terminal = frames.at(-1);
      expect(terminal?.type).toBe("done");

      const proposals = frames.filter((f) => f.type === "proposal");
      expect(proposals.length).toBeGreaterThanOrEqual(1);

      const interesting = proposals.filter(
        (f) =>
          f.type === "proposal" &&
          (f.proposal.tool === "setTrigger" || f.proposal.tool === "setInstructions"),
      );
      expect(interesting.length).toBeGreaterThanOrEqual(1);

      // Every streamed proposal must re-validate against the shared schemas.
      for (const frame of proposals) {
        if (frame.type !== "proposal") continue;
        const schema = copilotMutationParamSchemas[frame.proposal.tool];
        expect(schema.safeParse(frame.proposal.params).success).toBe(true);
      }

      // Report what the model actually proposed (smoke evidence, not pinned).
      console.log(
        "[keyed] proposals:",
        proposals
          .map((f) => (f.type === "proposal" ? f.proposal.tool : ""))
          .join(", "),
      );
      console.log("[keyed] applied draft:", JSON.stringify(draft, null, 2));

      // The applied draft must DRY-RUN-COMPILE clean through the real compiler.
      try {
        const result = compile(draft, compileDepsFor(draft));
        expect(result.files.size).toBeGreaterThan(0);
        expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      } catch (error) {
        if (error instanceof CompileError) {
          throw new Error(
            `applied draft failed dry-run compile [${error.code}]: ${error.message} ${JSON.stringify(error.details)}`,
          );
        }
        throw error;
      }
    },
    { timeout: 180_000 },
  );
});
