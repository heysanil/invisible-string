/**
 * Cross-package lockstep: every seeded agent draft must parse against the
 * canonical AgentDefinition schema (packages/shared). Isolated in its own
 * file so a shared-schema drift fails exactly one suite.
 */
import { describe, expect, test } from "bun:test";
import { agentDefinitionSchema } from "@invisible-string/shared";

import { DEFAULT_AGENTS } from "./seed";

describe("DEFAULT_AGENTS drafts vs shared agentDefinitionSchema", () => {
  for (const agent of DEFAULT_AGENTS) {
    test(`"${agent.name}" draft parses as an AgentDefinition`, () => {
      const parsed = agentDefinitionSchema.parse(agent.draft);
      expect(parsed.persona).toBe(agent.draft.persona);
      expect(parsed.model.preset).toBe(agent.draft.model.preset);
      expect(parsed.model.reasoning).toBe(agent.draft.model.reasoning);
      expect(parsed.context.mcpConnectionIds).toEqual([]);
      expect(parsed.context.skillIds).toEqual([]);
    });
  }
});
