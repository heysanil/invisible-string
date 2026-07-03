import { describe, expect, test } from "bun:test";

import {
  buildSlackInstallUrl,
  signOAuthState,
  verifyOAuthState,
  verifyOAuthStateDetailed,
  OAuthNonceCache,
} from "./slack-oauth";

const SECRET = "state-signing-secret-state-signing-01";

describe("OAuth state signing", () => {
  test("round-trips the workspace id", () => {
    const now = 1_720_000_000;
    const state = signOAuthState(SECRET, "org-123", now);
    expect(verifyOAuthState(SECRET, state, now + 10)).toBe("org-123");
  });

  test("rejects a tampered payload", () => {
    const state = signOAuthState(SECRET, "org-123", 1000);
    const tampered = `${Buffer.from(JSON.stringify({ workspaceId: "org-evil", exp: 9e9 }), "utf8").toString("base64url")}.${state.split(".")[1]}`;
    expect(verifyOAuthState(SECRET, tampered, 1000)).toBeNull();
  });

  test("rejects a wrong secret", () => {
    const state = signOAuthState(SECRET, "org-123", 1000);
    expect(verifyOAuthState("other-secret-other-secret-other-01", state, 1000)).toBeNull();
  });

  test("rejects an expired state", () => {
    const state = signOAuthState(SECRET, "org-123", 1000, 600);
    expect(verifyOAuthState(SECRET, state, 1000 + 601)).toBeNull();
  });

  test("rejects garbage", () => {
    expect(verifyOAuthState(SECRET, "not-a-state", 1000)).toBeNull();
    expect(verifyOAuthState(SECRET, "", 1000)).toBeNull();
  });

  test("detailed verify exposes the nonce; each mint gets a fresh one", () => {
    const now = 1_720_000_000;
    const a = verifyOAuthStateDetailed(SECRET, signOAuthState(SECRET, "org-1", now), now)!;
    const b = verifyOAuthStateDetailed(SECRET, signOAuthState(SECRET, "org-1", now), now)!;
    expect(a.workspaceId).toBe("org-1");
    expect(a.nonce.length).toBeGreaterThan(0);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.exp).toBe(now + 600);
  });
});

describe("OAuthNonceCache (single-use states)", () => {
  test("a nonce consumes exactly once; a replay within the TTL is refused", () => {
    const cache = new OAuthNonceCache();
    expect(cache.consume("nonce-1", 2000, 1000)).toBe(true);
    expect(cache.consume("nonce-1", 2000, 1001)).toBe(false); // replay
    expect(cache.consume("nonce-2", 2000, 1001)).toBe(true); // distinct nonce fine
  });

  test("expired entries are pruned (cache stays bounded)", () => {
    const cache = new OAuthNonceCache();
    expect(cache.consume("nonce-old", 1500, 1000)).toBe(true);
    // Past the state's own exp a replay is rejected by exp-verification
    // upstream, so pruning it is safe — and it frees the slot.
    expect(cache.consume("nonce-new", 9000, 2000)).toBe(true);
    expect(cache.consume("nonce-old", 9000, 2000)).toBe(true); // pruned → reusable, exp gate upstream
  });
});

describe("buildSlackInstallUrl", () => {
  test("carries client_id, scopes, redirect_uri, and state", () => {
    const url = new URL(
      buildSlackInstallUrl({
        clientId: "123.456",
        scopes: ["app_mentions:read", "chat:write"],
        redirectUri: "https://app.example.com/integrations/slack/callback",
        state: "signed-state",
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("123.456");
    expect(url.searchParams.get("scope")).toBe("app_mentions:read,chat:write");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/integrations/slack/callback",
    );
    expect(url.searchParams.get("state")).toBe("signed-state");
  });
});
