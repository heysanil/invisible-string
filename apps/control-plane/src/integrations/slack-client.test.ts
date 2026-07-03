/**
 * The control-plane Slack Web API client, driven against a STUB Slack server
 * (Bun.serve) — no real Slack in CI. Covers the OAuth code↔token exchange used
 * at install and chat.postMessage (the same protocol the compiled agent uses
 * for outbound replies).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createSlackClient } from "./slack-client";

interface OAuthCapture {
  contentType: string | null;
  params: Record<string, string>;
}

let server: ReturnType<typeof Bun.serve>;
const oauthCalls: OAuthCapture[] = [];
let oauthResponse: unknown = {};
const postCalls: { auth: string | null; body: unknown }[] = [];
let postResponse: unknown = { ok: true, ts: "1.0" };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/oauth.v2.access" && req.method === "POST") {
        const text = await req.text();
        const params = Object.fromEntries(new URLSearchParams(text));
        oauthCalls.push({ contentType: req.headers.get("content-type"), params });
        return Response.json(oauthResponse);
      }
      if (url.pathname === "/chat.postMessage" && req.method === "POST") {
        postCalls.push({
          auth: req.headers.get("authorization"),
          body: await req.json(),
        });
        return Response.json(postResponse);
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => server?.stop(true));

function client() {
  return createSlackClient({ apiBaseUrl: `http://localhost:${server.port}` });
}

describe("exchangeOAuthCode", () => {
  test("POSTs form-encoded credentials and parses the trimmed access result", async () => {
    oauthCalls.length = 0;
    oauthResponse = {
      ok: true,
      app_id: "A1",
      team: { id: "T123", name: "Acme" },
      bot_user_id: "U0BOT",
      access_token: "xoxb-secret-token",
      scope: "app_mentions:read,chat:write",
    };
    const result = await client().exchangeOAuthCode({
      clientId: "cid",
      clientSecret: "csecret",
      code: "the-code",
      redirectUri: "https://app.example.com/integrations/slack/callback",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.team.id).toBe("T123");
      expect(result.value.access_token).toBe("xoxb-secret-token");
    }
    expect(oauthCalls[0]!.contentType).toContain("application/x-www-form-urlencoded");
    expect(oauthCalls[0]!.params).toMatchObject({
      client_id: "cid",
      client_secret: "csecret",
      code: "the-code",
    });
  });

  test("maps a Slack { ok:false } to an error result", async () => {
    oauthResponse = { ok: false, error: "invalid_code" };
    const result = await client().exchangeOAuthCode({
      clientId: "cid",
      clientSecret: "csecret",
      code: "bad",
      redirectUri: "https://app.example.com/cb",
    });
    expect(result).toEqual({ ok: false, error: "invalid_code" });
  });
});

describe("postMessage", () => {
  test("posts with a bearer token + threaded body", async () => {
    postCalls.length = 0;
    postResponse = { ok: true, ts: "1720000000.000200" };
    const result = await client().postMessage({
      token: "xoxb-abc",
      channel: "C1",
      text: "hi there",
      threadTs: "1720000000.000100",
    });
    expect(result.ok).toBe(true);
    expect(postCalls[0]!.auth).toBe("Bearer xoxb-abc");
    expect(postCalls[0]!.body).toEqual({
      channel: "C1",
      text: "hi there",
      thread_ts: "1720000000.000100",
    });
  });

  test("surfaces a Slack error", async () => {
    postResponse = { ok: false, error: "channel_not_found" };
    const result = await client().postMessage({ token: "x", channel: "C1", text: "x" });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });
});
