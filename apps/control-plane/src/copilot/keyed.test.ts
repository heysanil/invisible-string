/**
 * KEYED copilot smoke — the single real-model test (cost discipline).
 * Gated on COPILOT_KEYED=1 AND OPENROUTER_API_KEY; skips cleanly otherwise.
 *
 * Runs one turn ("make me a workflow that triages support emails") against a
 * seeded fake workspace inventory through the REAL OpenRouter transport and
 * asserts STRUCTURAL validity only: the turn completes and produces at least
 * one schema-valid setTrigger or setInstructions proposal (never exact
 * content — models drift).
 */
import { describe, expect, test } from "bun:test";

import {
  copilotMutationParamSchemas,
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
      description: "reads the support inbox",
      enabled: true,
    },
  ],
  skills: [
    {
      id: "cccccccc-1111-4222-8333-444444444444",
      name: "Triage Guide",
      slug: "triage-guide",
      description: "how to classify and prioritize support emails",
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

describe.skipIf(!KEYED)("copilot keyed smoke (real OpenRouter model)", () => {
  test(
    "one-line request yields ≥1 valid setTrigger/setInstructions proposal",
    async () => {
      const config = loadCopilotConfig(process.env);
      const transport = createModelTransport(config, process.env);
      const frames: CopilotServerFrame[] = [];
      const session = new CopilotSession({
        transport,
        config,
        send: (frame) => {
          frames.push(frame);
          // Auto-accept every proposal so the loop runs to completion.
          if (frame.type === "proposal") {
            queueMicrotask(() =>
              session.resolveMutation(frame.proposal.id, { outcome: "accepted" }),
            );
          }
        },
      });

      await session.runTurn({
        message: "make me a workflow that triages support emails",
        draft: {
          trigger: { type: "manual" },
          context: { mcpConnectionIds: [], skillIds: [] },
          agent: { agentPresetId: inventory.agentPresets[0]!.id },
          instructions: { markdown: "" },
        },
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
    },
    { timeout: 180_000 },
  );
});
