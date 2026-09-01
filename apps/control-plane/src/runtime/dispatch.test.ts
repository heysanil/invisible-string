import { describe, expect, test } from "bun:test";

import {
  agentQualifiedThreadKeyPrefix,
  armDispatchAttempt,
  isModelAllowlisted,
  isProvablyUndispatched,
  publishedPipelineConfigOf,
  resolveEnabledPipeline,
  slackThreadKey,
} from "./dispatch";
import { mapIngressBody, shouldStartNewSlackSession } from "../integrations/routes";
import { isRuntimeApiError } from "./errors";
import { createMemoryRunStore } from "../pipeline/test-support";
import {
  newStepId,
  type SlackInnerEvent,
  type SlackTriggerBinding,
} from "@invisible-string/shared";

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

  test("agentQualifiedThreadKeyPrefix derives the per-agent claim namespace (never a bare-key collision)", () => {
    const bare = slackThreadKey("int-1", "C1", "1.0");
    expect(agentQualifiedThreadKeyPrefix(bare)).toBe("int-1:C1:1.0:agent:");
    // A qualified derivative can never equal any bare key: bare keys have
    // exactly two colons, derivatives at least four.
    expect(agentQualifiedThreadKeyPrefix(bare).split(":").length).toBeGreaterThan(3);
  });
});

// ── F1: dispatch-attempt marker + stillborn classification ──────────────────

describe("armDispatchAttempt (marker + pre-eve cancel fence)", () => {
  test("arms a queued run: startedAt is CAS-written while the status stays queued", async () => {
    const store = createMemoryRunStore();
    store.setStatus("run-1", "queued");
    const at = new Date("2026-09-01T00:00:00Z");
    expect(await armDispatchAttempt(store, "run-1", at)).toBe("armed");
    expect(store.statusLog).toHaveLength(1);
    expect(store.statusLog[0]).toMatchObject({
      runId: "run-1",
      patch: { status: "queued", startedAt: at },
    });
  });

  test("a run the cancel route already settled refuses the marker → 'canceled' (the dispatch abandons)", async () => {
    const store = createMemoryRunStore();
    store.setStatus("run-1", "canceled", "canceled by user");
    expect(await armDispatchAttempt(store, "run-1")).toBe("canceled");
    expect(store.statusLog).toHaveLength(0); // the CAS never wrote
  });

  test("any other terminal status reads 'terminal' (equally not dispatchable)", async () => {
    const store = createMemoryRunStore();
    store.setStatus("run-1", "failed", "swept");
    expect(await armDispatchAttempt(store, "run-1")).toBe("terminal");
  });
});

describe("isProvablyUndispatched (stillborn-child classification)", () => {
  const base = { status: "failed" as const, startedAt: null, eveSessionId: null };

  test("failed + no marker + no eve session id → provably undispatched (safe to re-dispatch)", () => {
    expect(isProvablyUndispatched(base)).toBe(true);
  });

  test("the marker alone flips it — the create MAY have been issued (fail honest)", () => {
    expect(isProvablyUndispatched({ ...base, startedAt: new Date() })).toBe(false);
  });

  test("a persisted eve session id flips it — eve definitely saw the create", () => {
    expect(isProvablyUndispatched({ ...base, eveSessionId: "eve-1" })).toBe(false);
  });

  test("non-failed statuses are never stillborn (canceled stays canceled; live runs are watched)", () => {
    for (const status of ["queued", "running", "waiting", "succeeded", "canceled"] as const) {
      expect(isProvablyUndispatched({ ...base, status })).toBe(false);
    }
  });
});

describe("publishedPipelineConfigOf / resolveEnabledPipeline", () => {
  const validPublished = {
    version: 2,
    trigger: { type: "webhook" },
    steps: [
      {
        id: newStepId(),
        slug: "reply",
        kind: "agent",
        agentId: null,
        instructions: { markdown: "do it" },
      },
    ],
  };
  const workflowRow = (overrides: Record<string, unknown>) =>
    ({
      id: "wf-1",
      organizationId: "org-1",
      enabled: true,
      published: validPublished,
      ...overrides,
    }) as never;

  test("parses a published v2 snapshot (defaults applied)", () => {
    const config = publishedPipelineConfigOf(workflowRow({}));
    expect(config.version).toBe(2);
    expect(config.overlap).toBe("skip"); // schema default
    expect(config.steps).toHaveLength(1);
  });

  test("never-published and unparseable snapshots are BOTH workflow_not_published", () => {
    for (const published of [null, { some: "pre-pipelines shape" }]) {
      try {
        publishedPipelineConfigOf(workflowRow({ published }));
        throw new Error("expected a throw");
      } catch (error) {
        expect(isRuntimeApiError(error)).toBe(true);
        if (isRuntimeApiError(error)) expect(error.code).toBe("workflow_not_published");
      }
    }
  });

  test("resolveEnabledPipeline checks the kill switch FIRST", () => {
    try {
      resolveEnabledPipeline(workflowRow({ enabled: false, published: null }));
      throw new Error("expected a throw");
    } catch (error) {
      expect(isRuntimeApiError(error)).toBe(true);
      if (isRuntimeApiError(error)) expect(error.code).toBe("trigger_disabled");
    }
    expect(resolveEnabledPipeline(workflowRow({})).version).toBe(2);
  });
});

describe("mapIngressBody (trigger-row formSchema is authoritative)", () => {
  // The persisted `form_schema` envelope, as setTriggerToken /
  // syncTriggerForPublish write it.
  const formSchema = {
    fields: [
      { key: "repo", label: "Repo", type: "text", required: true },
      { key: "message", label: "Message", type: "textarea", required: false },
    ],
  };

  test("webhook: passes the object through; message defaults", () => {
    expect(mapIngressBody("webhook", { repo: "acme/app" }, null)).toEqual({
      message: "Incoming webhook event.",
      data: { repo: "acme/app" },
    });
    expect(mapIngressBody("webhook", { message: "run it" }, null).message).toBe("run it");
  });

  test("webhook: non-object bodies are rejected", () => {
    for (const bad of [null, [], "text", 42]) {
      expect(() => mapIngressBody("webhook", bad, null)).toThrow(
        "webhook body must be a JSON object",
      );
    }
  });

  test("form: validates values against the PERSISTED form schema", () => {
    const mapped = mapIngressBody(
      "form",
      { values: { repo: "acme/app", message: "hello" } },
      formSchema,
    );
    expect(mapped).toEqual({
      message: "hello",
      data: { repo: "acme/app", message: "hello" },
    });
  });

  test("form: missing required field → form_validation_failed", () => {
    try {
      mapIngressBody("form", { values: { message: "hi" } }, formSchema);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isRuntimeApiError(error)) throw error;
      expect(error.code).toBe("form_validation_failed");
      expect(error.message).toContain("repo");
    }
  });

  test("form: a trigger row with no synced schema is rejected (republish to sync)", () => {
    for (const missing of [null, undefined, [], "nope"]) {
      try {
        mapIngressBody("form", { values: {} }, missing);
        expect.unreachable("should have thrown");
      } catch (error) {
        if (!isRuntimeApiError(error)) throw error;
        expect(error.code).toBe("form_validation_failed");
        expect(error.message).toContain("no form schema");
      }
    }
  });

  test("form: body must be { values: {…} }", () => {
    expect(() => mapIngressBody("form", { repo: "x" }, formSchema)).toThrow(
      "form body must be { values: { ... } }",
    );
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
