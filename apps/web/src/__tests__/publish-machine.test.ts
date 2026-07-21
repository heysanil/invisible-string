/**
 * Publish state machine: staged progress (compiling → building → ready),
 * cache-hit fast path, build-failure and network-failure error surfaces, and
 * re-entrancy guards.
 */
import { expect, test } from "bun:test";
import type { PublishAgentResponse } from "@invisible-string/shared";

import {
  INITIAL_PUBLISH_STATE,
  isPublishBusy,
  publishPhaseLabel,
  publishReducer,
  type PublishState,
} from "../lib/agents/publish-machine";

function response(
  overrides: Partial<PublishAgentResponse> = {},
): PublishAgentResponse {
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    contentHash: "hash123",
    buildStatus: "succeeded",
    cached: false,
    buildError: null,
    ...overrides,
  };
}

function run(events: Parameters<typeof publishReducer>[1][]): PublishState {
  let state = INITIAL_PUBLISH_STATE;
  for (const event of events) state = publishReducer(state, event);
  return state;
}

test("idle → start enters compiling and is busy", () => {
  const state = run([{ type: "start" }]);
  expect(state.phase).toBe("compiling");
  expect(isPublishBusy(state)).toBe(true);
  expect(publishPhaseLabel(state)).toBe("Compiling…");
});

test("a building response advances to building (not ready)", () => {
  const state = run([
    { type: "start" },
    { type: "received", response: response({ buildStatus: "building" }) },
  ]);
  expect(state.phase).toBe("building");
  expect(state.result).toBeNull();
  expect(publishPhaseLabel(state)).toBe("Building…");
});

test("a succeeded response reaches ready with the result", () => {
  const state = run([
    { type: "start" },
    { type: "received", response: response({ buildStatus: "succeeded" }) },
  ]);
  expect(state.phase).toBe("ready");
  expect(state.result?.contentHash).toBe("hash123");
  expect(isPublishBusy(state)).toBe(false);
  expect(publishPhaseLabel(state)).toBe("Published");
});

test("a cache hit is labelled distinctly", () => {
  const state = run([
    { type: "start" },
    {
      type: "received",
      response: response({ buildStatus: "succeeded", cached: true }),
    },
  ]);
  expect(state.phase).toBe("ready");
  expect(publishPhaseLabel(state)).toBe("Published (cached)");
});

test("a failed build surfaces the build error", () => {
  const state = run([
    { type: "start" },
    {
      type: "received",
      response: response({
        buildStatus: "failed",
        buildError: "tsc: type error in agent.ts",
      }),
    },
  ]);
  expect(state.phase).toBe("error");
  expect(state.error).toContain("type error");
});

test("a failed build with no message uses a readable fallback", () => {
  const state = run([
    { type: "start" },
    {
      type: "received",
      response: response({ buildStatus: "failed", buildError: null }),
    },
  ]);
  expect(state.phase).toBe("error");
  expect(state.error).toBeTruthy();
});

test("a network failure surfaces the given message", () => {
  const state = run([
    { type: "start" },
    { type: "failed", message: "Could not reach the server." },
  ]);
  expect(state.phase).toBe("error");
  expect(state.error).toBe("Could not reach the server.");
});

test("start is ignored while a publish is already in flight", () => {
  const busy = run([{ type: "start" }]);
  const again = publishReducer(busy, { type: "start" });
  expect(again).toBe(busy);
});

test("reset returns to idle from ready or error", () => {
  const ready = run([
    { type: "start" },
    { type: "received", response: response() },
  ]);
  expect(publishReducer(ready, { type: "reset" })).toEqual(
    INITIAL_PUBLISH_STATE,
  );
});
