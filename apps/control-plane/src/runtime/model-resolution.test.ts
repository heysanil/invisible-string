import { describe, expect, test } from "bun:test";

import { agentModelSchema } from "@invisible-string/shared";

import { RuntimeApiError } from "./errors";
import { resolveModel, type ModelResolutionData } from "./model-resolution";

function data(overrides: Partial<ModelResolutionData> = {}): ModelResolutionData {
  return {
    modelPresets: [
      {
        slug: "powerful",
        provider: "openrouter",
        modelId: "z-ai/glm-5.2",
        reasoning: "max",
      },
      {
        slug: "balanced",
        provider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        reasoning: "max",
      },
      // Same-model-different-effort is the shape the seeded balanced/quick
      // pair uses — the reason effort belongs to the preset at all.
      {
        slug: "quick",
        provider: "openrouter",
        modelId: "deepseek/deepseek-v4-flash",
        reasoning: "low",
      },
    ],
    allowlist: [
      { provider: "openrouter", modelId: "z-ai/glm-5.2", enabled: true },
      { provider: "openrouter", modelId: "deepseek/deepseek-v4-pro", enabled: true },
      { provider: "openrouter", modelId: "deepseek/deepseek-v4-flash", enabled: true },
      { provider: "anthropic", modelId: "claude-opus-4-8", enabled: true },
      { provider: "openrouter", modelId: "banned/model", enabled: false },
    ],
    ...overrides,
  };
}

/** Defaults-applied AgentModel (what a parsed AgentDefinition carries). */
function model(input: Record<string, unknown> = {}) {
  return agentModelSchema.parse(input);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RuntimeApiError) return error.code;
    throw error;
  }
  throw new Error("expected a RuntimeApiError");
}

describe("resolveModel", () => {
  test("default preset (balanced) maps through the workspace presets", () => {
    const resolved = resolveModel(model(), data());
    expect(resolved).toEqual({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
      reasoning: "max",
      presetSlug: "balanced",
    });
  });

  test("an explicit preset slug maps through the workspace presets", () => {
    const resolved = resolveModel(model({ preset: "quick" }), data());
    expect(resolved.modelId).toBe("deepseek/deepseek-v4-flash");
    expect(resolved.presetSlug).toBe("quick");
  });

  test("modelId override wins outright, provider from the allowlist row", () => {
    const resolved = resolveModel(
      model({ preset: "quick", modelId: "claude-opus-4-8" }),
      data(),
    );
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.modelId).toBe("claude-opus-4-8");
    expect(resolved.presetSlug).toBeUndefined();
  });

  // ── reasoning effort ───────────────────────────────────────────────────────

  test("an unset effort INHERITS the preset's own effort", () => {
    expect(resolveModel(model({ preset: "quick" }), data()).reasoning).toBe("low");
    expect(resolveModel(model({ preset: "powerful" }), data()).reasoning).toBe("max");
  });

  test("an explicit effort on the definition overrides the preset's", () => {
    expect(
      resolveModel(model({ preset: "quick", reasoning: "high" }), data()).reasoning,
    ).toBe("high");
  });

  test("a modelId override with no explicit effort resolves to provider-default, NOT the preset's effort (inheriting `quick`'s effort onto a deliberately-chosen model is the wrong semantic)", () => {
    const resolved = resolveModel(
      model({ preset: "quick", modelId: "claude-opus-4-8" }),
      data(),
    );
    expect(resolved.reasoning).toBe("provider-default");
  });

  test("a modelId override still honours an EXPLICIT effort", () => {
    const resolved = resolveModel(
      model({ modelId: "claude-opus-4-8", reasoning: "xhigh" }),
      data(),
    );
    expect(resolved.reasoning).toBe("xhigh");
  });

  test("the override branch never reads the preset table — a workspace with NO presets still resolves an override (regression: reading the preset there would invent a model_preset_not_found for drafts that publish fine today)", () => {
    const resolved = resolveModel(
      model({ modelId: "claude-opus-4-8" }),
      data({ modelPresets: [] }),
    );
    expect(resolved.reasoning).toBe("provider-default");
  });

  test("missing workspace preset mapping → model_preset_not_found", () => {
    expect(codeOf(() => resolveModel(model(), data({ modelPresets: [] })))).toBe(
      "model_preset_not_found",
    );
  });

  test("non-allowlisted override → model_not_allowlisted", () => {
    expect(
      codeOf(() => resolveModel(model({ modelId: "not/allowed" }), data())),
    ).toBe("model_not_allowlisted");
  });

  test("a DISABLED allowlist row does not allow the model", () => {
    expect(
      codeOf(() => resolveModel(model({ modelId: "banned/model" }), data())),
    ).toBe("model_not_allowlisted");
  });

  test("preset-mapped model must itself be allowlisted", () => {
    const stripped = data();
    stripped.allowlist = stripped.allowlist.filter(
      (row) => row.modelId !== "deepseek/deepseek-v4-pro",
    );
    expect(codeOf(() => resolveModel(model(), stripped))).toBe(
      "model_not_allowlisted",
    );
  });
});
