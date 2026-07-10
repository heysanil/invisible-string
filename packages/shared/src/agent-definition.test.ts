import { describe, expect, test } from "bun:test";

import {
  agentContextSchema,
  agentDefinitionSchema,
  agentModelSchema,
  modelPresetSlugSchema,
  reasoningEffortSchema,
  type AgentDefinitionInput,
} from "./agent-definition";

const UUID_A = "6b4d8f6e-3a4e-4f6a-9a0e-2f6a1c9d8e7b";
const UUID_B = "0f8fad5b-d9cb-469f-a165-70867728950e";

// ── Enums (mirror packages/db pgEnums) ──────────────────────────────────────

describe("model enums", () => {
  test("preset slugs mirror the model_preset_slug pgEnum", () => {
    expect(modelPresetSlugSchema.options).toEqual([
      "powerful",
      "balanced",
      "quick",
    ]);
  });

  test("reasoning efforts mirror the reasoning_effort pgEnum", () => {
    expect(reasoningEffortSchema.options).toEqual(["low", "medium", "high"]);
  });
});

// ── MODEL ───────────────────────────────────────────────────────────────────

describe("agentModelSchema", () => {
  test("applies balanced/medium defaults; modelId stays optional", () => {
    expect(agentModelSchema.parse({})).toEqual({
      preset: "balanced",
      reasoning: "medium",
    });
  });

  test("accepts a full model block", () => {
    const parsed = agentModelSchema.parse({
      preset: "quick",
      modelId: "deepseek/deepseek-v4-flash",
      reasoning: "high",
    });
    expect(parsed.preset).toBe("quick");
    expect(parsed.modelId).toBe("deepseek/deepseek-v4-flash");
    expect(parsed.reasoning).toBe("high");
  });

  test("rejects unknown preset slugs, reasoning efforts, empty modelId", () => {
    expect(agentModelSchema.safeParse({ preset: "turbo" }).success).toBe(false);
    expect(agentModelSchema.safeParse({ reasoning: "max" }).success).toBe(false);
    expect(agentModelSchema.safeParse({ modelId: "" }).success).toBe(false);
  });
});

// ── CONTEXT ─────────────────────────────────────────────────────────────────

describe("agentContextSchema", () => {
  test("defaults both id lists to empty arrays", () => {
    expect(agentContextSchema.parse({})).toEqual({
      mcpConnectionIds: [],
      skillIds: [],
    });
  });

  test("accepts uuids, rejects non-uuids", () => {
    expect(
      agentContextSchema.safeParse({ mcpConnectionIds: [UUID_A], skillIds: [UUID_B] })
        .success,
    ).toBe(true);
    expect(
      agentContextSchema.safeParse({ mcpConnectionIds: ["linear"] }).success,
    ).toBe(false);
  });

  test("rejects duplicate ids", () => {
    expect(
      agentContextSchema.safeParse({ mcpConnectionIds: [UUID_A, UUID_A] }).success,
    ).toBe(false);
    expect(agentContextSchema.safeParse({ skillIds: [UUID_B, UUID_B] }).success).toBe(
      false,
    );
  });
});

// ── Full definition ─────────────────────────────────────────────────────────

describe("agentDefinitionSchema", () => {
  test("parses a full definition and applies nested defaults", () => {
    const input = {
      persona: "You are a careful compliance reviewer.",
      model: { preset: "powerful" },
      context: { mcpConnectionIds: [UUID_A] },
    } satisfies AgentDefinitionInput;

    const parsed = agentDefinitionSchema.parse(input);
    expect(parsed.model.reasoning).toBe("medium");
    expect(parsed.context.skillIds).toEqual([]);
  });

  test("empty persona is a valid DRAFT and defaults to \"\"", () => {
    const parsed = agentDefinitionSchema.parse({ model: {}, context: {} });
    expect(parsed).toEqual({
      persona: "",
      model: { preset: "balanced", reasoning: "medium" },
      context: { mcpConnectionIds: [], skillIds: [] },
    });
  });

  test("rejects a definition missing the model or context block", () => {
    expect(
      agentDefinitionSchema.safeParse({ persona: "x", context: {} }).success,
    ).toBe(false);
    expect(
      agentDefinitionSchema.safeParse({ persona: "x", model: {} }).success,
    ).toBe(false);
  });

  test("rejects a non-string persona", () => {
    expect(
      agentDefinitionSchema.safeParse({ persona: 42, model: {}, context: {} })
        .success,
    ).toBe(false);
  });
});
