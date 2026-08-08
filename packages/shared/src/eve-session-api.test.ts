import { describe, expect, test } from "bun:test";

import {
  EVE_EMPTY_STREAM_TAIL_INDEX,
  EVE_FORBIDDEN_SESSION_BODY_KEYS,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ACCEPTED_STATUS,
  EVE_SESSION_ID_HEADER,
  EVE_SESSION_NOT_ACTIVE_CODE,
  EVE_SESSION_NOT_ACTIVE_STATUS,
  EVE_SESSION_ROUTE_PATH,
  EVE_STREAM_TAIL_INDEX_HEADER,
  eveCancelTurnResponseSchema,
  eveClearSessionResponseSchema,
  eveCompactSessionResponseSchema,
  eveCreateSessionRequestSchema,
  eveResetSessionResponseSchema,
  eveSessionAcceptedResponseSchema,
  eveSessionCancelPath,
  eveSessionClearPath,
  eveSessionCompactPath,
  eveSessionFollowUpRequestSchema,
  eveSessionPath,
  eveSessionResetPath,
  eveSessionStreamPath,
  eveStreamQueryString,
  forbiddenEveSessionBodyKey,
  isEveRespondRequest,
  isEveSessionNotActive,
  parseEveStreamTailIndex,
  type EveSessionFollowUpRequest,
} from "./eve-session-api";

const SESSION_ID = "wrun_01KZFM7CCZWQ4SXBPVV0CGA9HN";

describe("route paths", () => {
  test("match eve 0.31's canonical patterns", () => {
    expect(EVE_SESSION_ROUTE_PATH).toBe("/eve/v1/session");
    expect(eveSessionPath(SESSION_ID)).toBe(`/eve/v1/session/${SESSION_ID}`);
    expect(eveSessionCancelPath(SESSION_ID)).toBe(
      `/eve/v1/session/${SESSION_ID}/cancel`,
    );
    expect(eveSessionClearPath(SESSION_ID)).toBe(
      `/eve/v1/session/${SESSION_ID}/clear`,
    );
    expect(eveSessionCompactPath(SESSION_ID)).toBe(
      `/eve/v1/session/${SESSION_ID}/compact`,
    );
    expect(eveSessionResetPath(SESSION_ID)).toBe(
      `/eve/v1/session/${SESSION_ID}/reset`,
    );
    expect(eveSessionStreamPath(SESSION_ID)).toBe(
      `/eve/v1/session/${SESSION_ID}/stream`,
    );
  });

  test("session ids are escaped into the path", () => {
    expect(eveSessionPath("a/b?c")).toBe("/eve/v1/session/a%2Fb%3Fc");
  });

  test("header + stream constants are the 0.31.3 values", () => {
    expect(EVE_SESSION_ID_HEADER).toBe("x-eve-session-id");
    expect(EVE_STREAM_TAIL_INDEX_HEADER).toBe("x-eve-stream-tail-index");
    expect(EVE_MESSAGE_STREAM_VERSION).toBe("21");
  });
});

describe("the forbidden continuationToken key", () => {
  test("eve's guard is key PRESENCE, so null/undefined values trip it too", () => {
    expect(EVE_FORBIDDEN_SESSION_BODY_KEYS).toEqual(["continuationToken"]);
    expect(forbiddenEveSessionBodyKey({ message: "hi" })).toBeNull();
    expect(forbiddenEveSessionBodyKey({ continuationToken: "ct_1" })).toBe(
      "continuationToken",
    );
    expect(forbiddenEveSessionBodyKey({ continuationToken: null })).toBe(
      "continuationToken",
    );
    expect(forbiddenEveSessionBodyKey({ continuationToken: undefined })).toBe(
      "continuationToken",
    );
  });

  test("non-objects are not bodies", () => {
    expect(forbiddenEveSessionBodyKey(null)).toBeNull();
    expect(forbiddenEveSessionBodyKey("continuationToken")).toBeNull();
  });

  test("every request schema rejects the key outright (strict objects)", () => {
    expect(
      eveCreateSessionRequestSchema.safeParse({
        message: "hi",
        continuationToken: "ct_1",
      }).success,
    ).toBe(false);
    expect(
      eveSessionFollowUpRequestSchema.safeParse({
        message: "hi",
        continuationToken: "ct_1",
      }).success,
    ).toBe(false);
  });
});

describe("create request", () => {
  test("requires a non-empty message", () => {
    expect(eveCreateSessionRequestSchema.safeParse({ message: "hi" }).success).toBe(
      true,
    );
    expect(eveCreateSessionRequestSchema.safeParse({ message: "" }).success).toBe(
      false,
    );
    expect(eveCreateSessionRequestSchema.safeParse({}).success).toBe(false);
  });

  test("inputResponses on create is illegal (eve 400s it)", () => {
    expect(
      eveCreateSessionRequestSchema.safeParse({
        message: "hi",
        inputResponses: [{ requestId: "req_1", optionId: "approve" }],
      }).success,
    ).toBe(false);
  });

  test("mode + capabilities are the budget-behavior switch", () => {
    expect(
      eveCreateSessionRequestSchema.safeParse({ message: "hi", mode: "task" })
        .success,
    ).toBe(true);
    expect(
      eveCreateSessionRequestSchema.safeParse({
        message: "hi",
        mode: "conversation",
        capabilities: { requestInput: true },
      }).success,
    ).toBe(true);
    expect(
      eveCreateSessionRequestSchema.safeParse({ message: "hi", mode: "batch" })
        .success,
    ).toBe(false);
  });
});

describe("follow-up: send XOR respond", () => {
  test("accepts the send form", () => {
    const parsed = eveSessionFollowUpRequestSchema.safeParse({ message: "again" });
    expect(parsed.success).toBe(true);
  });

  test("accepts the respond form", () => {
    const parsed = eveSessionFollowUpRequestSchema.safeParse({
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects BOTH — eve: \"'message' and 'inputResponses' are mutually exclusive\"", () => {
    expect(
      eveSessionFollowUpRequestSchema.safeParse({
        message: "again",
        inputResponses: [{ requestId: "req_1", optionId: "approve" }],
      }).success,
    ).toBe(false);
  });

  test("rejects NEITHER, and rejects empty stand-ins", () => {
    expect(eveSessionFollowUpRequestSchema.safeParse({}).success).toBe(false);
    expect(
      eveSessionFollowUpRequestSchema.safeParse({ message: "" }).success,
    ).toBe(false);
    expect(
      eveSessionFollowUpRequestSchema.safeParse({ inputResponses: [] }).success,
    ).toBe(false);
  });

  test("input responses are strict (requestId required, no stray keys)", () => {
    expect(
      eveSessionFollowUpRequestSchema.safeParse({
        inputResponses: [{ optionId: "approve" }],
      }).success,
    ).toBe(false);
    expect(
      eveSessionFollowUpRequestSchema.safeParse({
        inputResponses: [{ requestId: "req_1", kind: "tool-approval" }],
      }).success,
    ).toBe(false);
  });

  test("the illegal state is unrepresentable at the type level", () => {
    const send: EveSessionFollowUpRequest = { message: "again" };
    const respond: EveSessionFollowUpRequest = {
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    };
    // @ts-expect-error — message and inputResponses can never coexist.
    const both: EveSessionFollowUpRequest = {
      message: "again",
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    };
    void both;

    expect(isEveRespondRequest(send)).toBe(false);
    expect(isEveRespondRequest(respond)).toBe(true);
  });
});

describe("response bodies", () => {
  test("create/follow-up accepted (202)", () => {
    expect(EVE_SESSION_ACCEPTED_STATUS).toBe(202);
    expect(
      eveSessionAcceptedResponseSchema.safeParse({
        ok: true,
        sessionId: SESSION_ID,
        status: "accepted",
      }).success,
    ).toBe(true);
    // 0.31 returns no continuation token — a body shaped like 0.19 must not parse.
    expect(
      eveSessionAcceptedResponseSchema.safeParse({
        sessionId: SESSION_ID,
        continuationToken: "ct_1",
      }).success,
    ).toBe(false);
  });

  test("cancel: accepted carries sessionId, no_active_turn does not", () => {
    const accepted = eveCancelTurnResponseSchema.parse({
      ok: true,
      sessionId: SESSION_ID,
      status: "accepted",
    });
    expect(accepted.status === "accepted" && accepted.sessionId).toBe(SESSION_ID);

    const idle = eveCancelTurnResponseSchema.parse({
      ok: true,
      status: "no_active_turn",
    });
    expect(idle.status).toBe("no_active_turn");
    expect("sessionId" in idle).toBe(false);

    expect(
      eveCancelTurnResponseSchema.safeParse({ ok: true, status: "no_active_session" })
        .success,
    ).toBe(false);
  });

  test("clear and compact share one shape", () => {
    for (const schema of [
      eveClearSessionResponseSchema,
      eveCompactSessionResponseSchema,
    ]) {
      expect(
        schema.safeParse({ ok: true, sessionId: SESSION_ID, status: "accepted" })
          .success,
      ).toBe(true);
      expect(
        schema.safeParse({ ok: true, status: "no_active_session" }).success,
      ).toBe(true);
      expect(schema.safeParse({ ok: true, status: "no_active_turn" }).success).toBe(
        false,
      );
    }
  });

  test("reset answers previousSessionId, NOT sessionId", () => {
    const reset = eveResetSessionResponseSchema.parse({
      ok: true,
      previousSessionId: SESSION_ID,
      status: "reset",
    });
    expect(reset.status === "reset" && reset.previousSessionId).toBe(SESSION_ID);

    expect(
      eveResetSessionResponseSchema.safeParse({
        ok: true,
        sessionId: SESSION_ID,
        status: "reset",
      }).success,
    ).toBe(false);
    expect(
      eveResetSessionResponseSchema.safeParse({ ok: true, status: "no_active_session" })
        .success,
    ).toBe(true);
  });
});

describe("session_not_active", () => {
  test("is the 409 code, matched on status AND code together", () => {
    expect(EVE_SESSION_NOT_ACTIVE_CODE).toBe("session_not_active");
    expect(EVE_SESSION_NOT_ACTIVE_STATUS).toBe(409);

    const body = {
      ok: false,
      code: "session_not_active",
      error: "The session is no longer active.",
    };
    expect(isEveSessionNotActive(409, body)).toBe(true);

    // A 409 during STREAM OPEN is retryable in eve's own client and is NOT
    // this condition — a bare status must never be enough.
    expect(isEveSessionNotActive(409, { ok: false, error: "Session not found." })).toBe(
      false,
    );
    expect(isEveSessionNotActive(500, body)).toBe(false);
    expect(isEveSessionNotActive(409, null)).toBe(false);
  });
});

describe("stream query + tail index", () => {
  test("omits startIndex at 0 and never emits a `follow` parameter", () => {
    expect(eveStreamQueryString()).toBe("");
    expect(eveStreamQueryString({ startIndex: 0 })).toBe("");
    expect(eveStreamQueryString({ startIndex: 7 })).toBe("?startIndex=7");
    expect(eveStreamQueryString({ startIndex: -1 })).toBe("?startIndex=-1");
    expect(eveStreamQueryString({ includeTailIndex: true })).toBe(
      "?includeTailIndex=1",
    );
    expect(eveStreamQueryString({ startIndex: 3, includeTailIndex: true })).toBe(
      "?startIndex=3&includeTailIndex=1",
    );
    expect(eveStreamQueryString({ includeTailIndex: false })).toBe("");
  });

  test("tail index distinguishes absent (null) from an empty stream (-1)", () => {
    expect(parseEveStreamTailIndex(null)).toBeNull();
    expect(parseEveStreamTailIndex(undefined)).toBeNull();
    expect(parseEveStreamTailIndex("")).toBeNull();
    expect(parseEveStreamTailIndex("not-a-number")).toBeNull();
    expect(parseEveStreamTailIndex("3.5")).toBeNull();
    expect(parseEveStreamTailIndex("99999999999999999999")).toBeNull();
    expect(parseEveStreamTailIndex("-1")).toBe(EVE_EMPTY_STREAM_TAIL_INDEX);
    expect(parseEveStreamTailIndex("0")).toBe(0);
    expect(parseEveStreamTailIndex("42")).toBe(42);
  });
});
