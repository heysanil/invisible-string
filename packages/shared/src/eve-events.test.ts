import { describe, expect, test } from "bun:test";

import {
  EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION,
  EVE_DEFAULT_SESSION_TIMEOUT_MS,
  EVE_EVENT_ID_PREFIX,
  EVE_INPUT_REQUEST_KINDS,
  EVE_SESSION_TOKEN_LIMIT_CODE,
  EVE_TURN_BOUNDARY_EVENT_TYPES,
  EVE_TURN_FAILURE_EVENT_TYPES,
  isEveEventId,
  LIVE_OBSERVED_EVE_EVENT_TYPES,
  type EveInputRequest,
  type EveInputRequestKind,
  type EveStreamEvent,
  type EveStreamEventType,
} from "./eve-events";

/**
 * Verbatim lines from the 0.31.3 spike captures (`spike/tests/fixtures/`),
 * re-typed as the shared union. If eve's wire shape drifts, these stop
 * compiling — which is the point: this file is the provenance contract.
 */
const CAPTURED: readonly EveStreamEvent[] = [
  // mocked-turn-events.ndjson:1
  {
    data: {
      runtime: {
        agentId: "spike-agent",
        agentName: "spike-agent",
        eveVersion: "0.31.3",
        modelId: "deepseek/deepseek-v4-flash",
      },
    },
    type: "session.started",
    meta: { at: "2026-08-08T02:46:16.163Z", id: "evt_01KZFM75B3T2JTRHFSWREBNTXD" },
  },
  // mocked-cancelled-events.ndjson:3 — 0.31 added `parts`
  {
    data: {
      message: "Call the slow_task tool with seconds: 5.",
      parts: [{ text: "Call the slow_task tool with seconds: 5.", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    },
    type: "message.received",
    meta: { at: "2026-08-08T02:46:23.605Z", id: "evt_01KZFM7CKN1P9HA23D346AXTPN" },
  },
  // mocked-parked-events.ndjson — the HITL park, now carrying `kind`
  {
    data: {
      requests: [
        {
          action: {
            callId: "call_record_note",
            input: { note: "durability-proof" },
            kind: "tool-call",
            toolName: "record_note",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: record_note",
          requestId: "aitxt-btHhgkpmCa97chxqwDmuXRoe",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    type: "input.requested",
    meta: { at: "2026-08-08T02:46:16.782Z", id: "evt_01KZFM75YE9K351QPXX4WZYKZ6" },
  },
  // mocked-turn-events.ndjson — step usage
  {
    data: {
      finishReason: "stop",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
      usage: {
        inputTokens: 640,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    type: "step.completed",
    meta: { at: "2026-08-08T02:46:16.180Z", id: "evt_01KZFM75BMSY27MB2R88X9ZS2F" },
  },
  // mocked-cancelled-events.ndjson — the Stop pair, in order
  {
    data: { sequence: 0, turnId: "turn_0" },
    type: "turn.cancelled",
    meta: { at: "2026-08-08T02:46:28.799Z", id: "evt_01KZFM7HNZ2Q2AFJM90D7CDYG8" },
  },
  {
    data: {
      continuationToken: "wrun_01KZFM7CCZWQ4SXBPVV0CGA9HN",
      wait: "next-user-message",
    },
    type: "session.waiting",
    meta: { at: "2026-08-08T02:46:28.799Z", id: "evt_01KZFM7HNZ2Q2AFJM90D7CDYG9" },
  },
];

describe("0.31.3 capture provenance", () => {
  test("every captured event carries a stamped evt_ ULID meta.id", () => {
    for (const event of CAPTURED) {
      expect(event.meta?.id).toBeString();
      expect(isEveEventId(event.meta?.id ?? "")).toBe(true);
      expect(event.meta?.id?.startsWith(EVE_EVENT_ID_PREFIX)).toBe(true);
    }
  });

  test("ids are unique within one session's captures", () => {
    const ids = CAPTURED.map((event) => event.meta?.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("isEveEventId rejects non-ids (a session id is not an event id)", () => {
    expect(isEveEventId("wrun_01KZFM7CCZWQ4SXBPVV0CGA9HN")).toBe(false);
    expect(isEveEventId("evt_")).toBe(false);
    expect(isEveEventId("evt_lowercase0123456789abcdef")).toBe(false);
    // I, L, O and U are excluded from Crockford base32.
    expect(isEveEventId("evt_01KZFM7HNZ2Q2AFJM90D7CDYGI")).toBe(false);
  });

  test("meta.id is optional in the type — legacy 0.19-era rows carry only `at`", () => {
    const legacy: EveStreamEvent = {
      type: "turn.started",
      data: { sequence: 0, turnId: "turn_0" },
      meta: { at: "2026-07-02T00:00:00.000Z" },
    };
    expect(legacy.meta?.id).toBeUndefined();
  });
});

describe("session.waiting compat echo", () => {
  test("data.continuationToken is the session id, and is never a request field", () => {
    const waiting = CAPTURED.find((event) => event.type === "session.waiting");
    expect(waiting?.type).toBe("session.waiting");
    // Present on the wire purely for compatibility — reading it back into a
    // request body is a hard 400 on eve 0.31 (see eve-session-api.ts).
    if (waiting?.type === "session.waiting") {
      expect(waiting.data.continuationToken).toStartWith("wrun_");
      expect(waiting.data.wait).toBe("next-user-message");
    }
  });
});

describe("HITL kind discriminator", () => {
  test("the exact 0.31 enum, nothing more", () => {
    expect([...EVE_INPUT_REQUEST_KINDS].sort()).toEqual([
      "question",
      "session-limit",
      "tool-approval",
    ]);
  });

  test("kind is required on EveInputRequest and routes presentation", () => {
    const request: EveInputRequest = {
      requestId: "req_1",
      prompt: "Continue this session?",
      kind: "session-limit",
      action: {
        callId: "call_1",
        kind: "tool-call",
        toolName: "session_limit",
        input: {},
      },
      options: [
        { id: "approve", label: "Continue" },
        { id: "stop", label: "Stop", style: "danger" },
      ],
      display: "confirmation",
    };
    // Exhaustive routing must compile for all three kinds.
    const label = (kind: EveInputRequestKind): string => {
      switch (kind) {
        case "tool-approval":
          return "approval";
        case "question":
          return "question";
        case "session-limit":
          return "budget";
      }
    };
    expect(label(request.kind)).toBe("budget");
    expect(EVE_INPUT_REQUEST_KINDS.map(label)).toEqual([
      "approval",
      "question",
      "budget",
    ]);
  });
});

describe("event union coverage", () => {
  test("0.31 additions are members of the union", () => {
    const added: EveStreamEventType[] = [
      "turn.cancelled",
      "context.cleared",
      "action.partial",
    ];
    for (const type of added) expect(typeof type).toBe("string");

    const cleared: EveStreamEvent = {
      type: "context.cleared",
      data: { sequence: 3, sessionId: "wrun_1", turnId: "turn_0" },
      meta: { at: "2026-08-08T02:46:28.799Z", id: "evt_01KZFM7HNZ2Q2AFJM90D7CDYGA" },
    };
    const partial: EveStreamEvent = {
      type: "action.partial",
      data: {
        result: {
          callId: "call_1",
          kind: "tool-result",
          toolName: "slow_task",
          output: { ok: false },
        },
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_0",
      },
    };
    expect(cleared.type).toBe("context.cleared");
    expect(partial.type).toBe("action.partial");
  });

  test("live-observed list matches the committed 0.31.3 fixtures", () => {
    expect([...LIVE_OBSERVED_EVE_EVENT_TYPES]).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "actions.requested",
      "input.requested",
      "action.result",
      "message.appended",
      "message.completed",
      "step.completed",
      "step.failed",
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "session.waiting",
    ]);
  });

  test("every captured event type is live-observed", () => {
    for (const event of CAPTURED) {
      expect(LIVE_OBSERVED_EVE_EVENT_TYPES as readonly string[]).toContain(event.type);
    }
  });
});

describe("turn boundary vs failure classification", () => {
  test("boundaries are the three session.* events — no turn.* member", () => {
    expect([...EVE_TURN_BOUNDARY_EVENT_TYPES]).toEqual([
      "session.completed",
      "session.failed",
      "session.waiting",
    ]);
    expect(EVE_TURN_BOUNDARY_EVENT_TYPES as readonly string[]).not.toContain("turn.cancelled");
    expect(EVE_TURN_BOUNDARY_EVENT_TYPES as readonly string[]).not.toContain("turn.completed");
  });

  test("turn.cancelled is NOT a failure — cancellation is a user decision", () => {
    expect([...EVE_TURN_FAILURE_EVENT_TYPES]).toEqual([
      "session.failed",
      "step.failed",
      "turn.failed",
    ]);
    expect(EVE_TURN_FAILURE_EVENT_TYPES as readonly string[]).not.toContain("turn.cancelled");
  });

  test("the captured Stop pair is cancelled-then-waiting, with no failure event", () => {
    const types = CAPTURED.map((event) => event.type);
    const cancelled = types.indexOf("turn.cancelled");
    expect(cancelled).toBeGreaterThanOrEqual(0);
    expect(types[cancelled + 1]).toBe("session.waiting");
    for (const failure of EVE_TURN_FAILURE_EVENT_TYPES) {
      expect(types as readonly string[]).not.toContain(failure);
    }
  });
});

describe("runtime limit constants (eve 0.31 defaults)", () => {
  test("mirror the values eve applies whether or not an agent configures them", () => {
    expect(EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION).toBe(40_000_000);
    expect(EVE_DEFAULT_SESSION_TIMEOUT_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(EVE_SESSION_TOKEN_LIMIT_CODE).toBe("SESSION_TOKEN_LIMIT_REACHED");
  });
});
