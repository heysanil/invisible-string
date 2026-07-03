import { describe, expect, test } from "bun:test";

import {
  createWebhookTokenResponseSchema,
  formIngressRequestSchema,
  integrationDtoSchema,
  runCancelRequestSchema,
  slackEventCallbackSchema,
  slackOAuthAccessResultSchema,
  slackUrlVerificationSchema,
  slackWebhookBodySchema,
  triggerBindingDtoSchema,
  triggerIngressResponseSchema,
  updateSlackTriggerBindingRequestSchema,
  webhookIngressRequestSchema,
  SLACK_REPLAY_WINDOW_SECONDS,
  SLACK_SIGNATURE_HEADER,
} from "./api";

const UUID = "6b4d8f6e-3a4e-4f6a-9a0e-2f6a1c9d8e7b";

describe("run cancel DTO", () => {
  test("body is optional; reason is bounded", () => {
    expect(runCancelRequestSchema.safeParse(undefined).success).toBe(true);
    expect(runCancelRequestSchema.safeParse({}).success).toBe(true);
    expect(runCancelRequestSchema.safeParse({ reason: "user aborted" }).success).toBe(
      true,
    );
    expect(runCancelRequestSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(
      runCancelRequestSchema.safeParse({ reason: "x".repeat(501) }).success,
    ).toBe(false);
  });
});

describe("/t/:token ingress", () => {
  test("webhook body must be a JSON object", () => {
    expect(webhookIngressRequestSchema.safeParse({ a: 1, nested: { b: 2 } }).success).toBe(
      true,
    );
    expect(webhookIngressRequestSchema.safeParse([1, 2, 3]).success).toBe(false);
    expect(webhookIngressRequestSchema.safeParse("scalar").success).toBe(false);
  });

  test("form body is { values }", () => {
    expect(
      formIngressRequestSchema.safeParse({ values: { repo: "acme/app" } }).success,
    ).toBe(true);
    expect(formIngressRequestSchema.safeParse({ repo: "x" }).success).toBe(false);
  });

  test("ingress response is a 202 ack with ids", () => {
    const parsed = triggerIngressResponseSchema.parse({
      accepted: true,
      runId: UUID,
      sessionId: UUID,
    });
    expect(parsed.accepted).toBe(true);
    expect(
      triggerIngressResponseSchema.safeParse({ accepted: false, runId: UUID, sessionId: UUID })
        .success,
    ).toBe(false);
  });
});

describe("Slack events ingress", () => {
  test("url_verification handshake", () => {
    const body = slackWebhookBodySchema.parse({
      type: "url_verification",
      token: "legacy",
      challenge: "abc123",
    });
    expect(body.type).toBe("url_verification");
    expect(slackUrlVerificationSchema.safeParse({ type: "url_verification" }).success).toBe(
      false,
    );
  });

  test("event_callback with an app_mention routes by team_id", () => {
    const body = slackWebhookBodySchema.parse({
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A123",
      event_id: "Ev123",
      event_time: 1720000000,
      event: {
        type: "app_mention",
        user: "U777",
        text: "<@U0BOT> hi",
        ts: "1720000000.000100",
        channel: "C123",
      },
    });
    expect(body.type).toBe("event_callback");
    if (body.type !== "event_callback") return;
    expect(body.team_id).toBe("T123");
    expect(body.event.type).toBe("app_mention");
  });

  test("event_callback with a threaded message", () => {
    const parsed = slackEventCallbackSchema.parse({
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "reply",
        ts: "2.0",
        thread_ts: "1.0",
      },
    });
    expect(parsed.event.type).toBe("message");
  });

  test("unknown top-level type fails to parse (route 200-acks anyway)", () => {
    expect(
      slackWebhookBodySchema.safeParse({ type: "app_rate_limited", team_id: "T1" }).success,
    ).toBe(false);
  });

  test("signature constants are locked", () => {
    expect(SLACK_SIGNATURE_HEADER).toBe("x-slack-signature");
    expect(SLACK_REPLAY_WINDOW_SECONDS).toBe(300);
  });
});

describe("Slack OAuth install result", () => {
  test("parses a trimmed oauth.v2.access response", () => {
    const parsed = slackOAuthAccessResultSchema.parse({
      ok: true,
      app_id: "A1",
      team: { id: "T123", name: "Acme" },
      bot_user_id: "U0BOT",
      access_token: "xoxb-secret",
      scope: "app_mentions:read,chat:write",
    });
    expect(parsed.team.id).toBe("T123");
    expect(parsed.access_token).toBe("xoxb-secret");
  });

  test("requires ok:true and an access_token", () => {
    expect(
      slackOAuthAccessResultSchema.safeParse({
        ok: false,
        team: { id: "T1" },
        access_token: "x",
      }).success,
    ).toBe(false);
  });
});

describe("integration DTO (read)", () => {
  test("reduces credentials to hasCredentials + non-secret metadata", () => {
    const dto = integrationDtoSchema.parse({
      id: UUID,
      type: "slack",
      externalId: "T123",
      teamName: "Acme",
      botUserId: "U0BOT",
      scopes: ["chat:write", "app_mentions:read"],
      hasCredentials: true,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    expect(dto.hasCredentials).toBe(true);
    expect("credentialsEncrypted" in dto).toBe(false);
    // nullable metadata for unknown fields
    expect(
      integrationDtoSchema.safeParse({
        ...dto,
        teamName: null,
        botUserId: null,
        scopes: [],
      }).success,
    ).toBe(true);
  });
});

describe("trigger binding DTOs", () => {
  test("webhook token mint returns plaintext ONCE + a 4-char suffix", () => {
    const parsed = createWebhookTokenResponseSchema.parse({
      triggerId: UUID,
      token: "whk_live_abcdef012345",
      tokenSuffix: "2345",
      ingressUrl: "https://app.example.com/t/whk_live_abcdef012345",
      createdAt: "2026-07-03T00:00:00.000Z",
    });
    expect(parsed.token).toBe("whk_live_abcdef012345");
    expect(parsed.tokenSuffix).toHaveLength(4);
    expect(
      createWebhookTokenResponseSchema.safeParse({ ...parsed, tokenSuffix: "toolong" })
        .success,
    ).toBe(false);
  });

  test("read DTO exposes no plaintext token, only hasToken + suffix", () => {
    const dto = triggerBindingDtoSchema.parse({
      id: UUID,
      workflowId: UUID,
      type: "webhook",
      enabled: true,
      hasToken: true,
      tokenSuffix: "2345",
      formSchema: null,
      slackBinding: null,
      integrationId: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    expect("token" in dto).toBe(false);
    expect(dto.hasToken).toBe(true);
  });

  test("form binding carries the form schema", () => {
    const dto = triggerBindingDtoSchema.parse({
      id: UUID,
      workflowId: UUID,
      type: "form",
      enabled: true,
      hasToken: true,
      tokenSuffix: null,
      formSchema: [{ key: "repo", label: "Repo", type: "text", required: true }],
      slackBinding: null,
      integrationId: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    expect(dto.formSchema?.[0]?.key).toBe("repo");
  });

  test("slack binding update points a workflow at an integration + rules", () => {
    const parsed = updateSlackTriggerBindingRequestSchema.parse({
      integrationId: UUID,
      binding: { channelId: "C123", mentionOnly: true, includeDirectMessages: false },
    });
    expect(parsed.binding.mentionOnly).toBe(true);
    // binding defaults apply (mentionOnly true, includeDirectMessages false)
    const defaulted = updateSlackTriggerBindingRequestSchema.parse({
      integrationId: UUID,
      binding: {},
    });
    expect(defaulted.binding.mentionOnly).toBe(true);
    expect(defaulted.binding.includeDirectMessages).toBe(false);
  });
});
