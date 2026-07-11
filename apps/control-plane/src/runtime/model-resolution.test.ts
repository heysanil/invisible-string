import { describe, expect, test } from "bun:test";

import { agentModelSchema } from "@invisible-string/shared";

import { RuntimeApiError } from "./errors";
import { resolveModel, type ModelResolutionData } from "./model-resolution";

function data(overrides: Partial<ModelResolutionData> = {}): ModelResolutionData {
  return {
    modelPresets: [
      { slug: "powerful", provider: "openrouter", modelId: "z-ai/glm-5.2" },
      { slug: "balanced", provider: "openrouter", modelId: "deepseek/deepseek-v4-pro" },
      { slug: "quick", provider: "openrouter", modelId: "deepseek/deepseek-v4-flash" },
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
