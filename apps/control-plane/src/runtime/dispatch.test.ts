import { describe, expect, test } from "bun:test";

import { isModelAllowlisted, slackThreadKey } from "./dispatch";
import { shouldStartNewSlackSession } from "../integrations/routes";
import type { SlackInnerEvent, SlackTriggerBinding } from "@invisible-string/shared";

describe("isModelAllowlisted (dispatch-time re-validation core)", () => {
  const allowlist = [
    { provider: "openrouter" as const, modelId: "deepseek/deepseek-v4-pro", enabled: true },
    { provider: "openrouter" as const, modelId: "z-ai/glm-5.2", enabled: false },
    { provider: "anthropic" as const, modelId: "claude-sonnet-5", enabled: true },
  ];

  test("true for an enabled provider+model", () => {
    expect(isModelAllowlisted(allowlist, "openrouter", "deepseek/deepseek-v4-pro")).toBe(true);
    expect(isModelAllowlisted(allowlist, "anthropic", "claude-sonnet-5")).toBe(true);
  });

  test("false when the model is disabled", () => {
    expect(isModelAllowlisted(allowlist, "openrouter", "z-ai/glm-5.2")).toBe(false);
  });

  test("false when the model is absent", () => {
    expect(isModelAllowlisted(allowlist, "openrouter", "some/other-model")).toBe(false);
  });

  test("false when the provider does not match", () => {
    expect(isModelAllowlisted(allowlist, "anthropic", "deepseek/deepseek-v4-pro")).toBe(false);
  });
});

describe("slackThreadKey", () => {
  test("namespaces thread_ts by integration + channel", () => {
    expect(slackThreadKey("int-1", "C1", "1.0")).toBe("int-1:C1:1.0");
    expect(slackThreadKey("int-1", "C2", "1.0")).not.toBe(slackThreadKey("int-1", "C1", "1.0"));
  });
});

describe("shouldStartNewSlackSession", () => {
  const mentionOnly: SlackTriggerBinding = { mentionOnly: true, includeDirectMessages: false };
  const openChannel: SlackTriggerBinding = { mentionOnly: false, includeDirectMessages: false };
  const dmsOn: SlackTriggerBinding = { mentionOnly: true, includeDirectMessages: true };

  const mention: SlackInnerEvent = {
    type: "app_mention",
    text: "<@U0BOT> hi",
    ts: "1.0",
    channel: "C1",
  };
  const channelMsg: SlackInnerEvent = {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    text: "hello",
    ts: "1.0",
  };
  const dm: SlackInnerEvent = {
    type: "message",
    channel: "D1",
    channel_type: "im",
    text: "hello",
    ts: "1.0",
  };

  test("a mention always starts a session (mention-only binding)", () => {
    expect(shouldStartNewSlackSession(mention, mentionOnly)).toBe(true);
  });

  test("a plain channel message does NOT start under a mention-only binding", () => {
    expect(shouldStartNewSlackSession(channelMsg, mentionOnly)).toBe(false);
  });

  test("a plain channel message starts under an open binding", () => {
    expect(shouldStartNewSlackSession(channelMsg, openChannel)).toBe(true);
  });

  test("a DM starts only when includeDirectMessages is set", () => {
    expect(shouldStartNewSlackSession(dm, mentionOnly)).toBe(false);
    expect(shouldStartNewSlackSession(dm, dmsOn)).toBe(true);
  });

  test("channel filter excludes other channels", () => {
    expect(
      shouldStartNewSlackSession(mention, { ...mentionOnly, channelId: "C-other" }),
    ).toBe(false);
    expect(
      shouldStartNewSlackSession(mention, { ...mentionOnly, channelId: "C1" }),
    ).toBe(true);
  });
});
