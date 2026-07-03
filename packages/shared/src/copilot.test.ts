import { describe, expect, test } from "bun:test";

import {
  copilotMutationSchema,
  parseCopilotClientFrame,
  parseCopilotServerFrame,
  type CopilotClientFrame,
  type CopilotServerFrame,
} from "./copilot";
import type { WorkflowDefinition } from "./workflow-definition";

const draft: WorkflowDefinition = {
  trigger: { type: "manual" },
  context: { mcpConnectionIds: [], skillIds: [] },
  agent: { agentPresetId: "a1111111-1111-4111-8111-111111111111" },
  instructions: { markdown: "Do the thing" },
};

describe("copilot frames", () => {
  test("round-trips a valid server suggestion frame", () => {
    const frame: CopilotServerFrame = {
      type: "suggestion",
      suggestion: {
        id: "s1",
        rationale: "why",
        mutation: { kind: "setInstructions", markdown: "New" },
      },
    };
    expect(parseCopilotServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  test("rejects malformed payloads instead of throwing", () => {
    expect(parseCopilotServerFrame("not json")).toBeNull();
    expect(parseCopilotServerFrame(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(parseCopilotServerFrame(new ArrayBuffer(4) as unknown)).toBeNull();
  });

  test("client frames validate the embedded draft", () => {
    const good: CopilotClientFrame = { type: "user_message", text: "hi", draft };
    expect(parseCopilotClientFrame(JSON.stringify(good))).toEqual(good);
    const bad = { type: "user_message", text: "hi", draft: { nope: true } };
    expect(parseCopilotClientFrame(JSON.stringify(bad))).toBeNull();
  });

  test("every mutation kind parses; unknown kinds are rejected", () => {
    const kinds = [
      { kind: "setTrigger", trigger: { type: "webhook" } },
      { kind: "addContext", contextKind: "skill", id: "s" },
      { kind: "removeContext", contextKind: "connection", id: "c" },
      { kind: "setAgent", agentPresetId: "a" },
      { kind: "setModelPreset", preset: "balanced" },
      { kind: "setModelPreset", preset: null },
      { kind: "setInstructions", markdown: "" },
    ];
    for (const mutation of kinds) {
      expect(copilotMutationSchema.safeParse(mutation).success).toBe(true);
    }
    expect(
      copilotMutationSchema.safeParse({ kind: "dropTables" }).success,
    ).toBe(false);
  });
});
