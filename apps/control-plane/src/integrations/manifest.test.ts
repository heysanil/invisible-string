import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { slackChannelTypeSchema } from "@invisible-string/shared";

import { DEFAULT_SLACK_BOT_SCOPES, slackRedirectUri } from "./config";

/**
 * Drift guard: infra/slack/manifest.template.json is the operator-facing
 * description of the platform Slack app (docs/SLACK.md), and it must never
 * diverge from what this code actually requests and serves. Slack rejects a
 * manifest that subscribes to a message.<surface> event without the matching
 * <surface>:history scope, so bot_events are DERIVED here from the scope
 * defaults rather than asserted as a second hand-maintained list.
 */
const PLACEHOLDER = "__PUBLIC_APP_URL__";

const manifestPath = join(
  import.meta.dir,
  "../../../../infra/slack/manifest.template.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Slack couples each message event subscription to its history scope.
const HISTORY_SCOPE_TO_EVENT: Record<string, string> = {
  "channels:history": "message.channels",
  "groups:history": "message.groups",
  "im:history": "message.im",
  "mpim:history": "message.mpim",
};

const CHANNEL_TYPE_TO_EVENT: Record<string, string> = {
  channel: "message.channels",
  group: "message.groups",
  im: "message.im",
  mpim: "message.mpim",
};

describe("slack app manifest template", () => {
  test("bot scopes match DEFAULT_SLACK_BOT_SCOPES", () => {
    expect([...manifest.oauth_config.scopes.bot].sort()).toEqual(
      [...DEFAULT_SLACK_BOT_SCOPES].sort(),
    );
  });

  test("bot_events are exactly the events the default scopes permit", () => {
    const expected = [
      "app_mention", // requires app_mentions:read (in the defaults)
      ...DEFAULT_SLACK_BOT_SCOPES.filter((s) => s in HISTORY_SCOPE_TO_EVENT).map(
        (s) => HISTORY_SCOPE_TO_EVENT[s],
      ),
    ];
    expect([...manifest.settings.event_subscriptions.bot_events].sort()).toEqual(
      expected.sort(),
    );
    expect(DEFAULT_SLACK_BOT_SCOPES).toContain("app_mentions:read");
  });

  test("every channel type the ingress schema accepts has a known event mapping", () => {
    // If a channel type is added to the shared schema, decide here whether the
    // app should subscribe to it (scope + manifest event) or keep tolerating
    // it as robustness only.
    for (const channelType of slackChannelTypeSchema.options) {
      expect(CHANNEL_TYPE_TO_EVENT[channelType]).toBeDefined();
    }
  });

  test("request_url points at the shared events ingress route", () => {
    // POST /integrations/slack/events (routes.ts) — one URL for all teams;
    // events are routed internally by team_id.
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      `${PLACEHOLDER}/integrations/slack/events`,
    );
  });

  test("redirect_urls match the OAuth callback the control plane serves", () => {
    expect(manifest.oauth_config.redirect_urls).toEqual([
      slackRedirectUri(PLACEHOLDER),
    ]);
  });

  test("capabilities the platform does not serve stay disabled", () => {
    // Events arrive over HTTP at request_url — there is no socket-mode client.
    expect(manifest.settings.socket_mode_enabled).toBe(false);
    // No interactivity/slash-command/shortcut handler exists on the ingress.
    expect(manifest.settings.interactivity.is_enabled).toBe(false);
    // Stored credentials are a static botToken decrypted at dispatch
    // (crypto.ts); token rotation would invalidate them.
    expect(manifest.settings.token_rotation_enabled).toBe(false);
  });
});
