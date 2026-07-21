/**
 * Pure unit tests for the seed builders — no database required.
 * Locked model defaults per INITIAL-SPEC.md §2/§7; default agents per the
 * agents-first redesign spec.
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_AGENTS,
  DEFAULT_MODEL_PRESETS,
  buildAgentRows,
  buildAllowlistRows,
  buildModelPresetRows,
} from "./seed";

const ORG = "org_test";
const OWNER = "user_owner";

describe("model preset seeds (locked, spec §2)", () => {
  test("exactly the three locked presets, all via OpenRouter", () => {
    expect(DEFAULT_MODEL_PRESETS).toHaveLength(3);
    const bySlug = new Map(DEFAULT_MODEL_PRESETS.map((p) => [p.slug, p]));
    expect(bySlug.get("powerful")).toEqual({
      slug: "powerful",
      provider: "openrouter",
      modelId: "z-ai/glm-5.2",
    });
    expect(bySlug.get("balanced")).toEqual({
      slug: "balanced",
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
    });
    expect(bySlug.get("quick")).toEqual({
      slug: "quick",
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
    });
  });

  test("buildModelPresetRows stamps the organization id on every row", () => {
    const rows = buildModelPresetRows(ORG);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.organizationId).toBe(ORG);
    }
    expect(rows.map((r) => r.slug)).toEqual(["powerful", "balanced", "quick"]);
  });

  test("builders are deterministic", () => {
    expect(buildModelPresetRows(ORG)).toEqual(buildModelPresetRows(ORG));
    expect(buildAllowlistRows(ORG)).toEqual(buildAllowlistRows(ORG));
    expect(buildAgentRows(ORG, OWNER)).toEqual(buildAgentRows(ORG, OWNER));
  });
});

describe("allowlist seeds", () => {
  test("one enabled allowlist row per seeded preset model", () => {
    const rows = buildAllowlistRows(ORG);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => `${r.provider}:${r.modelId}`).sort()).toEqual(
      DEFAULT_MODEL_PRESETS.map((p) => `${p.provider}:${p.modelId}`).sort(),
    );
    for (const row of rows) {
      expect(row.enabled).toBe(true);
      expect(row.organizationId).toBe(ORG);
    }
  });
});

describe("default agent seeds", () => {
  test("General Purpose / Software Engineer / Product Designer", () => {
    expect(DEFAULT_AGENTS.map((a) => a.name)).toEqual([
      "General Purpose",
      "Software Engineer",
      "Product Designer",
    ]);
  });

  test("all drafts are full AgentDefinitions on the balanced preset", () => {
    for (const agent of DEFAULT_AGENTS) {
      expect(agent.draft.persona.length).toBeGreaterThan(80);
      expect(agent.draft.model).toEqual({
        preset: "balanced",
        reasoning: "medium",
      });
      expect(agent.draft.context).toEqual({
        mcpConnectionIds: [],
        skillIds: [],
      });
      expect(agent.description.length).toBeGreaterThan(10);
    }
  });

  test("buildAgentRows stamps the organization id and run-as user", () => {
    const rows = buildAgentRows(ORG, OWNER);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.organizationId).toBe(ORG);
      expect(row.runAsUserId).toBe(OWNER);
    }
  });
});
