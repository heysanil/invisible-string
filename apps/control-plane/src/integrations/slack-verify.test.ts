import { describe, expect, test } from "bun:test";

import {
  SlackEventDedup,
  computeSlackSignature,
  verifySlackRequest,
} from "./slack-verify";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const RAW_BODY = JSON.stringify({ type: "event_callback", team_id: "T1" });

describe("verifySlackRequest", () => {
  const ts = 1_720_000_000;

  function signedRequest(overrides: Partial<Parameters<typeof verifySlackRequest>[0]> = {}) {
    const timestamp = String(ts);
    return verifySlackRequest({
      signingSecret: SIGNING_SECRET,
      timestamp,
      signature: computeSlackSignature(SIGNING_SECRET, timestamp, RAW_BODY),
      rawBody: RAW_BODY,
      replayWindowSeconds: 300,
      nowSeconds: ts,
      ...overrides,
    });
  }

  test("accepts a correctly signed, fresh request", () => {
    expect(signedRequest().ok).toBe(true);
  });

  test("rejects a tampered body (signature mismatch)", () => {
    const result = signedRequest({ rawBody: RAW_BODY + " " });
    expect(result.ok).toBe(false);
  });

  test("rejects a wrong signing secret", () => {
    const result = signedRequest({ signingSecret: "wrong-secret-wrong-secret-wrong-1" });
    expect(result.ok).toBe(false);
  });

  test("rejects a replayed (stale) timestamp outside the window", () => {
    const result = signedRequest({ nowSeconds: ts + 301 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("replay");
  });

  test("accepts a timestamp at the edge of the window", () => {
    expect(signedRequest({ nowSeconds: ts + 300 }).ok).toBe(true);
  });

  test("rejects missing headers", () => {
    expect(verifySlackRequest({
      signingSecret: SIGNING_SECRET,
      signature: null,
      timestamp: null,
      rawBody: RAW_BODY,
      replayWindowSeconds: 300,
    }).ok).toBe(false);
  });
});

describe("SlackEventDedup", () => {
  test("first sighting proceeds, retries are skipped", () => {
    const dedup = new SlackEventDedup();
    expect(dedup.markSeen("Ev123")).toBe(true);
    expect(dedup.markSeen("Ev123")).toBe(false);
    expect(dedup.markSeen("Ev999")).toBe(true);
  });

  test("evicts oldest ids past the cap", () => {
    const dedup = new SlackEventDedup(2);
    dedup.markSeen("a");
    dedup.markSeen("b");
    dedup.markSeen("c"); // evicts "a"
    expect(dedup.markSeen("a")).toBe(true); // "a" forgotten → treated as new
    expect(dedup.markSeen("c")).toBe(false); // "c" still remembered
  });
});
