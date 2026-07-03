import { describe, expect, test } from "bun:test";

import {
  buildSlackInstallUrl,
  signOAuthState,
  verifyOAuthState,
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
