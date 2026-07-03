import { describe, expect, test } from "bun:test";

import {
  createSessionRequestSchema,
  postMessageRequestSchema,
  RUN_STREAM_EVENT_NAMES,
  type RunEventFrame,
} from "./api";
import type { EveStreamEvent } from "./eve-events";

describe("request schemas", () => {
  test("createSessionRequest requires a non-empty message", () => {
    expect(createSessionRequestSchema.safeParse({ message: "hello" }).success).toBe(
      true,
    );
    expect(createSessionRequestSchema.safeParse({ message: "" }).success).toBe(false);
    expect(createSessionRequestSchema.safeParse({}).success).toBe(false);
  });

  test("postMessageRequest requires a non-empty message", () => {
    expect(postMessageRequestSchema.safeParse({ message: "again" }).success).toBe(
      true,
    );
    expect(postMessageRequestSchema.safeParse({ message: "" }).success).toBe(false);
  });
});

describe("run stream contract", () => {
  test("frame names are stable", () => {
    expect(RUN_STREAM_EVENT_NAMES).toEqual(["run_event", "run_status"]);
  });

  test("RunEventFrame carries frozen eve stream events", () => {
    // Compile-time contract check exercised at runtime with a live-observed shape.
    const event: EveStreamEvent = {
      type: "turn.started",
      data: { sequence: 0, turnId: "turn_0" },
      meta: { at: "2026-07-02T00:00:00.000Z" },
    };
    const frame: RunEventFrame = {
      runId: "run_1",
      seq: 0,
      event,
      at: "2026-07-02T00:00:00.001Z",
    };
    expect(frame.event.type).toBe("turn.started");
  });
});
