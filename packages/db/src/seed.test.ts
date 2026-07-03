/**
 * Pure unit tests for the seed builders — no database required.
 * Locked defaults per INITIAL-SPEC.md §2/§7.
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_AGENT_PRESETS,
  DEFAULT_MODEL_PRESETS,
  buildAgentPresetRows,
  buildAllowlistRows,
  buildModelPresetRows,
} from "./seed";

const ORG = "org_test";

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
    expect(buildAgentPresetRows(ORG)).toEqual(buildAgentPresetRows(ORG));
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

describe("agent preset seeds", () => {
  test("General Purpose / Software Engineer / Product Designer", () => {
    expect(DEFAULT_AGENT_PRESETS.map((p) => p.name)).toEqual([
      "General Purpose",
      "Software Engineer",
      "Product Designer",
    ]);
  });

  test("all default to the balanced model preset with a real base prompt", () => {
    for (const preset of DEFAULT_AGENT_PRESETS) {
      expect(preset.modelPreset).toBe("balanced");
      expect(preset.basePrompt.length).toBeGreaterThan(80);
      expect(preset.reasoningEffort).toBe("medium");
      expect(preset.description.length).toBeGreaterThan(10);
    }
  });

  test("buildAgentPresetRows stamps the organization id", () => {
    const rows = buildAgentPresetRows(ORG);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.organizationId).toBe(ORG);
    }
  });
});
