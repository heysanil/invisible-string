/**
 * Shared eve **0.31** session-API guards for the in-repo fake agents.
 *
 * Test doubles are only worth what they REFUSE. The 0.19 fakes enforced the
 * old contract (409 on a continuation-token mismatch); rewriting them by just
 * deleting those checks would leave doubles that happily accept a body real
 * eve answers with a 400 — hiding exactly the protocol mismatch production
 * would hit. These helpers re-implement 0.31's actual refusals:
 *
 * - `continuationToken` anywhere in the body of ANY session route → 400. eve's
 *   check is `"continuationToken" in body`, so `null`/`undefined` values trip
 *   it too once they survive serialization.
 * - follow-up bodies are `message` XOR `inputResponses`: both → 400, neither →
 *   400, empty `inputResponses` → 400.
 * - `inputResponses` on CREATE → 400 (existing sessions only).
 * - unknown / retired session id on a follow-up → 409
 *   `{ok:false, code:"session_not_active"}`.
 *
 * Not a copy of eve — a copy of the parts a control-plane regression would
 * otherwise sail through.
 */
import {
  EVE_SESSION_NOT_ACTIVE_CODE,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_SESSION_ID_HEADER,
} from "@invisible-string/shared";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 400 body shape eve uses for every validation refusal (no `code` field). */
export function eveBadRequest(error: string): Response {
  return Response.json({ error, ok: false }, { status: 400, headers: NO_STORE });
}

/** The 409 every dead/unknown/retired session id answers on a follow-up. */
export function eveSessionNotActive(): Response {
  return Response.json(
    {
      code: EVE_SESSION_NOT_ACTIVE_CODE,
      error: "The session is no longer active.",
      ok: false,
    },
    { status: 409, headers: NO_STORE },
  );
}

/** 202 accepted — create and follow-up alike. */
export function eveAccepted(sessionId: string): Response {
  return Response.json(
    { ok: true, sessionId, status: "accepted" },
    {
      status: 202,
      headers: { ...NO_STORE, [EVE_SESSION_ID_HEADER]: sessionId },
    },
  );
}

/**
 * eve's `rejectSessionContinuationToken`, applied to every session route.
 * Returns the 400 Response when the key is present, else null.
 */
export function rejectContinuationToken(body: unknown): Response | null {
  if (typeof body === "object" && body !== null && "continuationToken" in body) {
    return eveBadRequest("Session-ID routes do not accept 'continuationToken'.");
  }
  return null;
}

export type FollowUpBody =
  | { kind: "send"; message: string }
  | { kind: "respond"; inputResponses: { requestId: string }[] };

/**
 * Parse a follow-up body under 0.31's send-XOR-respond rule. Returns either
 * the parsed form or the exact Response eve would answer with.
 */
export function parseFollowUpBody(body: unknown): FollowUpBody | Response {
  const rejected = rejectContinuationToken(body);
  if (rejected) return rejected;
  const record = (body ?? {}) as {
    message?: unknown;
    inputResponses?: unknown;
    forwardedPrincipal?: unknown;
  };
  if (record.forwardedPrincipal !== undefined) {
    return eveBadRequest("'forwardedPrincipal' is only accepted on create.");
  }
  const hasMessage =
    typeof record.message === "string" && record.message.length > 0;
  const hasResponses =
    Array.isArray(record.inputResponses) && record.inputResponses.length > 0;
  if (hasMessage && record.inputResponses !== undefined) {
    return eveBadRequest("'message' and 'inputResponses' are mutually exclusive.");
  }
  if (!hasMessage && !hasResponses) {
    return eveBadRequest(
      "Expected a non-empty 'message' or a non-empty 'inputResponses' array.",
    );
  }
  return hasMessage
    ? { kind: "send", message: record.message as string }
    : {
        kind: "respond",
        inputResponses: record.inputResponses as { requestId: string }[],
      };
}

/** Parse a CREATE body: `message` required, `inputResponses` forbidden. */
export function parseCreateBody(body: unknown): { message: string } | Response {
  const rejected = rejectContinuationToken(body);
  if (rejected) return rejected;
  const record = (body ?? {}) as { message?: unknown; inputResponses?: unknown };
  if (record.inputResponses !== undefined) {
    return eveBadRequest("'inputResponses' is only accepted for an existing session.");
  }
  if (typeof record.message !== "string" || record.message.length === 0) {
    return eveBadRequest("Expected a non-empty 'message'.");
  }
  return { message: record.message };
}

let eventCounter = 0;

/**
 * A stable, sortable stand-in for eve's `evt_`-prefixed ULID. Only the
 * PROPERTIES the tailer relies on matter: unique per event, and identical
 * every time the same event is replayed (the fake assigns it once, at emit).
 */
export function fakeEveEventId(): string {
  eventCounter += 1;
  return `evt_${eventCounter.toString(36).padStart(26, "0").toUpperCase()}`;
}

/** Stamp `meta` on an event exactly as eve does before its durable write. */
export function stampEveEvent<T extends Record<string, unknown>>(event: T): T {
  return {
    ...event,
    meta: { at: new Date().toISOString(), id: fakeEveEventId() },
  };
}

/**
 * Response headers for a stream open. `x-eve-stream-tail-index` is emitted
 * ONLY when the request asked for it — the tailer must tolerate its absence
 * (fall back to its own cursor) and distinguish that from `-1` (empty stream).
 */
export function eveStreamHeaders(
  url: URL,
  eventCount: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store, no-transform",
  };
  const includeTailIndex = url.searchParams.get("includeTailIndex");
  if (includeTailIndex === "1" || includeTailIndex === "true") {
    headers[EVE_STREAM_TAIL_INDEX_HEADER] = String(eventCount - 1);
  }
  return headers;
}
