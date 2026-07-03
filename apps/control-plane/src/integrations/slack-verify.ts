/**
 * Slack Events API request authentication (docs/PLAN.md Phase 3 task 3.1;
 * INITIAL-SPEC.md §11). Two gates run FIRST, before any body parsing or
 * routing:
 *
 * 1. Signature — `v0=<hex>` = HMAC-SHA256(signingSecret, `v0:<ts>:<rawBody>`),
 *    compared in constant time. Requires the RAW request body (byte-exact) —
 *    re-serializing parsed JSON would change bytes and break the signature.
 * 2. Replay window — reject when |now − ts| > 5 min (SLACK_REPLAY_WINDOW_SECONDS)
 *    so a captured request cannot be replayed later.
 *
 * Retries (`x-slack-retry-num`) re-deliver the SAME `event_id`; {@link SlackEventDedup}
 * makes consumption idempotent so a slow first attempt + a retry don't run the
 * workflow twice.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { SLACK_SIGNATURE_VERSION } from "@invisible-string/shared";

export type SlackVerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface VerifySlackRequestInput {
  signingSecret: string;
  /** `x-slack-signature` header (e.g. "v0=abc…"). */
  signature: string | null;
  /** `x-slack-request-timestamp` header (unix seconds, as a string). */
  timestamp: string | null;
  /** The RAW request body bytes as a string (NOT re-serialized JSON). */
  rawBody: string;
  /** Replay window in seconds. */
  replayWindowSeconds: number;
  /** Injectable clock in unix seconds (tests). Defaults to Date.now/1000. */
  nowSeconds?: number;
}

/** Compute the expected Slack signature for a raw body + timestamp. */
export function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): string {
  const base = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", signingSecret).update(base, "utf8").digest("hex");
  return `${SLACK_SIGNATURE_VERSION}=${digest}`;
}

/**
 * Verify a Slack Events API request: replay window FIRST (cheap), then a
 * constant-time signature compare. Returns a typed result so the route can
 * 401/400 without leaking which gate failed to a caller.
 */
export function verifySlackRequest(input: VerifySlackRequestInput): SlackVerifyResult {
  const { signature, timestamp, rawBody, signingSecret } = input;
  if (!signature || !timestamp) {
    return { ok: false, reason: "missing signature or timestamp header" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid timestamp" };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > input.replayWindowSeconds) {
    return { ok: false, reason: "timestamp outside the replay window" };
  }
  const expected = computeSlackSignature(signingSecret, timestamp, rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

/**
 * Bounded LRU set of consumed Slack `event_id`s for retry idempotency. Slack
 * retries carry the same event_id (with `x-slack-retry-num`); `markSeen`
 * returns true the FIRST time an id is presented and false on repeats so a
 * retry short-circuits to a 200-ack without re-dispatching.
 */
export class SlackEventDedup {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = 5_000) {}

  /** True when this id is NEW (proceed); false when already consumed (skip). */
  markSeen(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    this.order.push(eventId);
    if (this.order.length > this.maxEntries) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }
}
