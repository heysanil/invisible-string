/**
 * KEYED copilot smoke — the single real-model test (cost discipline).
 * Gated on COPILOT_KEYED=1 AND OPENROUTER_API_KEY; skips cleanly otherwise.
 *
 * Runs one AGENT-surface turn ("equip this agent to triage support email…")
 * against a seeded fake workspace inventory through the REAL OpenRouter
 * transport, auto-accepts every proposal, APPLIES each one to an
 * AgentDefinition draft the way the agent editor controller would, and
 * asserts:
 * - the turn completes with ≥1 schema-valid setPersona/addContext proposal
 *   (STRUCTURAL checks only — models drift, content is never pinned);
 * - the applied definition DRY-RUN-COMPILES CLEAN through the real compiler
 *   (the agent is the compile unit — this is the publish-parity proof).
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
  agentDefinitionSchema,
  copilotMutationParamSchemas,
  type AgentDefinition,
  type CopilotProposal,
  type CopilotServerFrame,
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
      scope: "workspace",
      health: "ok",
      tools: ["search_threads", "create_draft"],
      toolCount: 2,
      cachedTools: [
        {
          name: "search_threads",
          description: "Search Gmail threads",
          params: ["query"],
        },
        {
          name: "create_draft",
          description: "Create a Gmail draft reply",
          params: ["to", "body"],
        },
      ],
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
  agents: [],
  modelPresets: [
    {
      slug: "powerful",
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4.8",
      reasoning: "max",
    },
    {
      slug: "balanced",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
      reasoning: "high",
    },
    {
      slug: "quick",
      provider: "openrouter",
      modelId: "anthropic/claude-haiku-4.5",
      reasoning: "low",
    },
  ],
  allowlist: [
    {
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
      enabled: true,
      supportedEfforts: ["max", "high", "low"],
    },
    {
      provider: "openrouter",
      modelId: "anthropic/claude-haiku-4.5",
      enabled: true,
      supportedEfforts: ["max", "high", "low"],
    },
  ],
  catalogAvailable: true,
};

/** Apply an accepted proposal to the draft — mirrors the agent editor reducer. */
function applyProposal(draft: AgentDefinition, proposal: CopilotProposal): void {
  switch (proposal.tool) {
    case "setPersona":
      draft.persona = proposal.params.markdown;
      break;
    case "setModel":
      if (proposal.params.preset !== undefined) {
        draft.model.preset = proposal.params.preset;
      }
      if (proposal.params.modelId !== undefined) {
        draft.model.modelId = proposal.params.modelId;
      }
      // Three-valued on the wire: absent leaves the draft alone, `null`
      // CLEARS the override (back to inheriting the preset's effort), a value
      // sets it — the same mapping the agent editor's reducer performs.
      if (proposal.params.reasoning !== undefined) {
        draft.model.reasoning = proposal.params.reasoning ?? undefined;
      }
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
    default:
      // Workflow-surface tools never validate on an agent turn.
      throw new Error(`unexpected tool on the agent surface: ${proposal.tool}`);
  }
}

/** Resolve compile deps for the applied draft (what the control plane does). */
function compileDepsFor(definition: AgentDefinition): CompileDeps {
  const mapped = inventory.modelPresets.find(
    (preset) => preset.slug === definition.model.preset,
  );
  const modelId =
    definition.model.modelId ?? mapped?.modelId ?? "anthropic/claude-sonnet-5";
  // Mirrors resolveModel: the definition's own effort wins; otherwise a
  // preset inherits its effort and a specific-model override falls to
  // `provider-default`.
  const reasoning =
    definition.model.reasoning ??
    (definition.model.modelId !== undefined
      ? ("provider-default" as const)
      : (mapped?.reasoning ?? ("provider-default" as const)));

  const connections: ResolvedMcpConnection[] =
    definition.context.mcpConnectionIds.map((id) => {
      const row = inventory.connections.find((c) => c.id === id);
      return {
        id,
        slug: row?.slug ?? "unknown",
        url: "https://mcp.example.com/mcp",
        description: row?.description ?? "",
        auth: { kind: "none" },
        approval: { mode: "once" },
      };
    });
  const skills: ResolvedSkill[] = definition.context.skillIds.map((id) => {
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
    resolvedModel: { provider: "openrouter", modelId, reasoning },
    workspaceSlug: "keyed-smoke",
    // Stable identity for the hash (spec D1); this smoke test has one agent,
    // so any fixed id serves — what matters is that it is not the slug.
    agentId: "11111111-1111-4111-8111-111111111111",
    agentSlug: "support-agent",
    connections,
    skills,
  };
}

describe.skipIf(!KEYED)("copilot keyed smoke (real OpenRouter model)", () => {
  test(
    "an agent-surface turn yields valid proposals whose applied definition dry-run-compiles clean",
    async () => {
      const config = loadCopilotConfig(process.env);
      const transport = createModelTransport(config, process.env);
      const frames: CopilotServerFrame[] = [];

      const draft: AgentDefinition = agentDefinitionSchema.parse({
        persona: "You are a helpful support agent.",
        model: { preset: "balanced", reasoning: "medium" },
        context: { mcpConnectionIds: [], skillIds: [] },
      });

      const session = new CopilotSession({
        transport,
        config,
        send: (frame) => {
          frames.push(frame);
          // Auto-accept every proposal (Apply) so the loop runs to completion;
          // apply it to the draft exactly as the editor controller would.
          if (frame.type === "proposal") {
            applyProposal(draft, frame.proposal);
            queueMicrotask(() =>
              session.resolveMutation(frame.proposal.id, { outcome: "accepted" }),
            );
          }
        },
      });

      await session.runTurn({
        surface: "agent",
        message:
          "equip this agent to triage support email from the inbox and draft replies using the triage guide",
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
          (f.proposal.tool === "setPersona" || f.proposal.tool === "addContext"),
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
      console.log("[keyed] applied definition:", JSON.stringify(draft, null, 2));

      // The applied definition must DRY-RUN-COMPILE clean through the real
      // compiler (agent publish parity).
      try {
        const result = compile(draft, compileDepsFor(draft));
        expect(result.files.size).toBeGreaterThan(0);
        expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      } catch (error) {
        if (error instanceof CompileError) {
          throw new Error(
            `applied definition failed dry-run compile [${error.code}]: ${error.message} ${JSON.stringify(error.details)}`,
          );
        }
        throw error;
      }
    },
    { timeout: 180_000 },
  );
});
