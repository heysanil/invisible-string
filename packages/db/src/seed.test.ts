/**
 * Pure unit tests for the seed builders — no database required.
 * Model defaults per the 2026-08-08 reasoning-effort + model-defaults spec;
 * default agents per the agents-first redesign spec.
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

describe("model preset seeds", () => {
  test("exactly the three presets, all via OpenRouter, each with an effort", () => {
    expect(DEFAULT_MODEL_PRESETS).toHaveLength(3);
    const bySlug = new Map(DEFAULT_MODEL_PRESETS.map((p) => [p.slug, p]));
    expect(bySlug.get("powerful")).toEqual({
      slug: "powerful",
      provider: "openrouter",
      modelId: "moonshotai/kimi-k3",
      reasoning: "max",
    });
    expect(bySlug.get("balanced")).toEqual({
      slug: "balanced",
      provider: "openrouter",
      modelId: "~deepseek/deepseek-v4-flash-latest",
      reasoning: "max",
    });
    expect(bySlug.get("quick")).toEqual({
      slug: "quick",
      provider: "openrouter",
      modelId: "~deepseek/deepseek-v4-flash-latest",
      reasoning: "low",
    });
  });

  test("balanced and quick are the same model at different efforts", () => {
    const bySlug = new Map(DEFAULT_MODEL_PRESETS.map((p) => [p.slug, p]));
    const balanced = bySlug.get("balanced")!;
    const quick = bySlug.get("quick")!;
    expect(quick.modelId).toBe(balanced.modelId);
    expect(quick.reasoning).not.toBe(balanced.reasoning);
  });

  test("no seeded preset uses `medium` — none of the models supports it", () => {
    for (const preset of DEFAULT_MODEL_PRESETS) {
      expect(preset.reasoning).not.toBe("medium");
    }
  });

  test("buildModelPresetRows stamps the organization id and carries the effort", () => {
    const rows = buildModelPresetRows(ORG);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.organizationId).toBe(ORG);
    }
    expect(rows.map((r) => r.slug)).toEqual(["powerful", "balanced", "quick"]);
    expect(rows.map((r) => r.reasoning)).toEqual(["max", "max", "low"]);
  });

  test("builders are deterministic", () => {
    expect(buildModelPresetRows(ORG)).toEqual(buildModelPresetRows(ORG));
    expect(buildAllowlistRows(ORG)).toEqual(buildAllowlistRows(ORG));
    expect(buildAgentRows(ORG, OWNER)).toEqual(buildAgentRows(ORG, OWNER));
  });
});

describe("allowlist seeds", () => {
  test("one enabled allowlist row per DISTINCT seeded preset model", () => {
    const rows = buildAllowlistRows(ORG);
    const distinct = [
      ...new Set(DEFAULT_MODEL_PRESETS.map((p) => `${p.provider}:${p.modelId}`)),
    ];
    // Two presets, one model: the insert would otherwise carry a row that
    // conflicts with its own sibling inside a single statement.
    expect(rows).toHaveLength(distinct.length);
    expect(rows.map((r) => `${r.provider}:${r.modelId}`).sort()).toEqual(
      distinct.sort(),
    );
    for (const row of rows) {
      expect(row.enabled).toBe(true);
      expect(row.organizationId).toBe(ORG);
    }
  });

  test("rows are unique by (provider, modelId)", () => {
    const keys = buildAllowlistRows(ORG).map((r) => `${r.provider}:${r.modelId}`);
    expect(new Set(keys).size).toBe(keys.length);
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

  test("all drafts are full AgentDefinitions on the balanced preset, inheriting its effort", () => {
    for (const agent of DEFAULT_AGENTS) {
      expect(agent.draft.persona.length).toBeGreaterThan(80);
      // No `reasoning` key at all — an explicit effort here would pin an
      // override on every workspace's starter agents.
      expect(agent.draft.model).toEqual({ preset: "balanced" });
      expect("reasoning" in agent.draft.model).toBe(false);
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
