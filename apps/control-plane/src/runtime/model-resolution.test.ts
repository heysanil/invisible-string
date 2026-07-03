import { describe, expect, test } from "bun:test";

import { RuntimeApiError } from "./errors";
import {
  resolveModel,
  type AgentPresetRow,
  type ModelResolutionData,
} from "./model-resolution";

const PRESET: AgentPresetRow = {
  id: "agent-1",
  name: "General Purpose",
  basePrompt: "You are helpful.",
  reasoningEffort: "medium",
  modelPreset: "balanced",
  modelId: null,
};

function data(overrides: Partial<ModelResolutionData> = {}): ModelResolutionData {
  return {
    agentPreset: PRESET,
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
  test("agent preset's default slug maps through workspace presets", () => {
    const resolved = resolveModel({ agentPresetId: PRESET.id }, data());
    expect(resolved).toMatchObject({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
      presetSlug: "balanced",
      reasoning: "medium",
      agentName: "General Purpose",
    });
  });

  test("workflow modelPreset override beats the agent preset's slug", () => {
    const resolved = resolveModel(
      { agentPresetId: PRESET.id, modelPreset: "quick" },
      data(),
    );
    expect(resolved.modelId).toBe("deepseek/deepseek-v4-flash");
    expect(resolved.presetSlug).toBe("quick");
  });

  test("workflow modelId override wins outright, provider from allowlist", () => {
    const resolved = resolveModel(
      { agentPresetId: PRESET.id, modelId: "claude-opus-4-8", modelPreset: "quick" },
      data(),
    );
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.modelId).toBe("claude-opus-4-8");
    expect(resolved.presetSlug).toBeUndefined();
  });

  test("agent preset's own modelId override applies when workflow has none", () => {
    const resolved = resolveModel(
      { agentPresetId: PRESET.id },
      data({ agentPreset: { ...PRESET, modelId: "z-ai/glm-5.2" } }),
    );
    expect(resolved.modelId).toBe("z-ai/glm-5.2");
  });

  test("reasoning override on the workflow wins", () => {
    const resolved = resolveModel(
      { agentPresetId: PRESET.id, reasoning: "high" },
      data(),
    );
    expect(resolved.reasoning).toBe("high");
  });

  test("missing agent preset → agent_preset_not_found", () => {
    expect(
      codeOf(() => resolveModel({ agentPresetId: "nope" }, data({ agentPreset: null }))),
    ).toBe("agent_preset_not_found");
  });

  test("missing workspace preset mapping → model_preset_not_found", () => {
    expect(
      codeOf(() =>
        resolveModel({ agentPresetId: PRESET.id }, data({ modelPresets: [] })),
      ),
    ).toBe("model_preset_not_found");
  });

  test("non-allowlisted override → model_not_allowlisted", () => {
    expect(
      codeOf(() =>
        resolveModel({ agentPresetId: PRESET.id, modelId: "not/allowed" }, data()),
      ),
    ).toBe("model_not_allowlisted");
  });

  test("a DISABLED allowlist row does not allow the model", () => {
    expect(
      codeOf(() =>
        resolveModel({ agentPresetId: PRESET.id, modelId: "banned/model" }, data()),
      ),
    ).toBe("model_not_allowlisted");
  });

  test("preset-mapped model must itself be allowlisted", () => {
    const stripped = data();
    stripped.allowlist = stripped.allowlist.filter(
      (row) => row.modelId !== "deepseek/deepseek-v4-pro",
    );
    expect(codeOf(() => resolveModel({ agentPresetId: PRESET.id }, stripped))).toBe(
      "model_not_allowlisted",
    );
  });
});
