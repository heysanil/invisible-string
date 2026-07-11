/**
 * DeliveryService unit tests — pure helpers (stop-message extraction, thread
 * key parsing, reply targeting), the settle state machine (pending-only CAS,
 * failed/canceled runs, missing replies/keys/integrations), the Slack
 * chat.postMessage payload, and the boot-time recovery sweep — all against
 * in-memory fakes (no DB, no network, no real Slack).
 */
import { describe, expect, test } from "bun:test";

import {
  encryptIntegrationCredentials,
} from "../integrations/crypto";
import type {
  PostMessageInput,
  PostMessageResult,
  SlackClient,
} from "../integrations/slack-client";
import { createLogger } from "../log";
import {
  createDeliveryService,
  lastStopMessageFrom,
  parseSlackThreadKey,
  slackReplyTargetFrom,
  type DeliverableRun,
  type DeliveryIntegration,
  type DeliveryReader,
} from "./delivery";
import {
  generateMasterKeyBase64,
  parseMasterKey,
  type EveStreamEvent,
} from "@invisible-string/shared";

const MASTER_KEY = parseMasterKey(generateMasterKeyBase64());
const TEAM_ID = "T-DELIVER";
const BOT_TOKEN = "xoxb-delivery-test-token";
const INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";

const silentLogger = createLogger({ sink: () => {}, minLevel: "error" });

function stopEvent(message: string | null, finishReason = "stop"): EveStreamEvent {
  return {
    type: "message.completed",
    data: { finishReason, message, sequence: 0, stepIndex: 0, turnId: "t0" },
  } as EveStreamEvent;
}

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeWorld {
  reader: DeliveryReader;
  runs: Map<string, DeliverableRun>;
  events: Map<string, EveStreamEvent[]>;
  integrations: Map<string, DeliveryIntegration>;
  deliveries: Array<{ runId: string; status: "delivered" | "failed"; error: string | null }>;
  posts: PostMessageInput[];
  slack: SlackClient;
  outcomes: string[];
}

function fakeWorld(options: { postResult?: PostMessageResult } = {}): FakeWorld {
  const runs = new Map<string, DeliverableRun>();
  const events = new Map<string, EveStreamEvent[]>();
  const integrations = new Map<string, DeliveryIntegration>();
  const deliveries: FakeWorld["deliveries"] = [];
  const posts: PostMessageInput[] = [];
  return {
    runs,
    events,
    integrations,
    deliveries,
    posts,
    outcomes: [],
    reader: {
      async loadRun(runId) {
        return runs.get(runId) ?? null;
      },
      async loadIntegration(id) {
        return integrations.get(id) ?? null;
      },
      async listPendingSucceededRunIds() {
        return [...runs.values()]
          .filter((r) => r.runStatus === "succeeded" && r.deliveryStatus === "pending")
          .map((r) => r.runId);
      },
      async listRunEvents(runId) {
        return events.get(runId) ?? [];
      },
    },
    slack: {
      async exchangeOAuthCode() {
        throw new Error("not used");
      },
      async postMessage(input) {
        posts.push(input);
        return options.postResult ?? { ok: true, ts: "1.0" };
      },
    },
  };
}

function slackRun(overrides: Partial<DeliverableRun> = {}): DeliverableRun {
  return {
    runId: "run-1",
    runStatus: "succeeded",
    deliveryStatus: "pending",
    organizationId: "org-1",
    origin: "slack",
    slackThreadKey: `${INTEGRATION_ID}:C-CHAN:1720000100.000100`,
    triggerData: {
      channel: "C-CHAN",
      ts: "1720000100.000100",
      thread_ts: "1720000100.000100",
      text: "hello",
    },
    ...overrides,
  };
}

function slackIntegration(): DeliveryIntegration {
  return {
    id: INTEGRATION_ID,
    type: "slack",
    externalId: TEAM_ID,
    credentialsEncrypted: encryptIntegrationCredentials(
      JSON.stringify({ botToken: BOT_TOKEN }),
      MASTER_KEY,
      "slack",
      TEAM_ID,
    ),
  };
}

/** `masterKey: null` = deployment without ENCRYPTION_MASTER_KEY. */
function service(world: FakeWorld, masterKey: typeof MASTER_KEY | null = MASTER_KEY) {
  return createDeliveryService({
    reader: world.reader,
    runStore: {
      async markDelivery(runId, status, error) {
        const run = world.runs.get(runId);
        // Mirror the drizzle CAS: only a pending obligation settles.
        if (!run || run.deliveryStatus !== "pending") return false;
        run.deliveryStatus = status;
        world.deliveries.push({ runId, status, error: error ?? null });
        return true;
      },
    },
    slackClient: world.slack,
    masterKey: masterKey ?? undefined,
    logger: silentLogger,
    onOutcome: (outcome) => world.outcomes.push(outcome),
  });
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("lastStopMessageFrom", () => {
  test("takes the LAST stop-message (leftover drains are harmless)", () => {
    expect(
      lastStopMessageFrom([
        stopEvent("old (previous turn leftover)"),
        { type: "turn.started", data: { sequence: 1, turnId: "t1" } } as EveStreamEvent,
        stopEvent("interim narration", "tool-calls"),
        stopEvent("the real reply"),
      ]),
    ).toBe("the real reply");
  });

  test("null when no stop-message exists", () => {
    expect(lastStopMessageFrom([])).toBeNull();
    expect(lastStopMessageFrom([stopEvent("interim", "tool-calls")])).toBeNull();
    expect(lastStopMessageFrom([stopEvent(null)])).toBeNull();
  });
});

describe("parseSlackThreadKey", () => {
  test("splits integrationId:channel:threadTs", () => {
    expect(parseSlackThreadKey("int-1:C1:1720.0")).toEqual({
      integrationId: "int-1",
      channel: "C1",
      threadTs: "1720.0",
    });
  });

  test("null on malformed keys", () => {
    expect(parseSlackThreadKey("")).toBeNull();
    expect(parseSlackThreadKey("only-one-part")).toBeNull();
    expect(parseSlackThreadKey("a:b")).toBeNull();
    expect(parseSlackThreadKey("a:b:c:d")).toBeNull();
    expect(parseSlackThreadKey("a::c")).toBeNull();
  });
});

describe("slackReplyTargetFrom", () => {
  test("prefers thread_ts, falls back to ts", () => {
    expect(slackReplyTargetFrom({ channel: "C1", thread_ts: "1.0", ts: "2.0" })).toEqual({
      channel: "C1",
      threadTs: "1.0",
    });
    expect(slackReplyTargetFrom({ channel: "C1", ts: "2.0" })).toEqual({
      channel: "C1",
      threadTs: "2.0",
    });
  });

  test("nulls when the envelope lacks routing", () => {
    expect(slackReplyTargetFrom({})).toEqual({ channel: null, threadTs: null });
  });
});

// ── deliver ──────────────────────────────────────────────────────────────────

describe("DeliveryService.deliver", () => {
  test("posts the tailer-tracked reply as a threaded chat.postMessage and settles delivered", async () => {
    const world = fakeWorld();
    world.runs.set("run-1", slackRun());
    world.integrations.set(INTEGRATION_ID, slackIntegration());

    const outcome = await service(world).deliver({
      runId: "run-1",
      status: "succeeded",
      lastAssistantMessage: "here is your report",
    });

    expect(outcome).toBe("delivered");
    // The payload the dead codegen used: channel + text + thread_ts, bot token.
    expect(world.posts).toEqual([
      {
        token: BOT_TOKEN,
        channel: "C-CHAN",
        text: "here is your report",
        threadTs: "1720000100.000100",
      },
    ]);
    expect(world.runs.get("run-1")!.deliveryStatus).toBe("delivered");
    expect(world.outcomes).toEqual(["delivered"]);
  });

  test("recovers the reply from run_events when the hook carried none", async () => {
    const world = fakeWorld();
    world.runs.set("run-1", slackRun());
    world.integrations.set(INTEGRATION_ID, slackIntegration());
    world.events.set("run-1", [
      stopEvent("old leftover"),
      stopEvent("recovered reply"),
    ]);

    const outcome = await service(world).deliver({
      runId: "run-1",
      status: "succeeded",
      lastAssistantMessage: null,
    });

    expect(outcome).toBe("delivered");
    expect(world.posts[0]!.text).toBe("recovered reply");
  });

  test("skips runs owing nothing (null/settled deliveryStatus) without posting", async () => {
    const world = fakeWorld();
    world.runs.set("chat", slackRun({ runId: "chat", deliveryStatus: null }));
    world.runs.set("done", slackRun({ runId: "done", deliveryStatus: "delivered" }));
    const svc = service(world);

    expect(
      await svc.deliver({ runId: "chat", status: "succeeded", lastAssistantMessage: "x" }),
    ).toBe("skipped");
    expect(
      await svc.deliver({ runId: "done", status: "succeeded", lastAssistantMessage: "x" }),
    ).toBe("skipped");
    expect(
      await svc.deliver({ runId: "ghost", status: "succeeded", lastAssistantMessage: "x" }),
    ).toBe("skipped");
    expect(world.posts).toHaveLength(0);
    expect(world.deliveries).toHaveLength(0);
  });

  test("a parked (waiting) hook fire leaves the obligation pending", async () => {
    const world = fakeWorld();
    world.runs.set("run-1", slackRun({ runStatus: "waiting" }));
    const outcome = await service(world).deliver({
      runId: "run-1",
      status: "waiting",
      lastAssistantMessage: null,
    });
    expect(outcome).toBe("skipped");
    expect(world.runs.get("run-1")!.deliveryStatus).toBe("pending");
  });

  test("a failed run settles failed without posting (recovery never reconsiders it)", async () => {
    const world = fakeWorld();
    world.runs.set("run-1", slackRun({ runStatus: "failed" }));
    const outcome = await service(world).deliver({
      runId: "run-1",
      status: "failed",
      lastAssistantMessage: null,
    });
    expect(outcome).toBe("failed");
    expect(world.posts).toHaveLength(0);
    expect(world.deliveries[0]).toMatchObject({
      runId: "run-1",
      status: "failed",
    });
    expect(world.deliveries[0]!.error).toContain("run failed");
  });

  test.each([
    [
      "no terminal reply anywhere",
      slackRun(),
      "no terminal assistant reply",
    ],
    [
      "missing slack thread key",
      slackRun({ slackThreadKey: null, triggerData: {} }),
      "no slack thread key",
    ],
    [
      "malformed slack thread key",
      slackRun({ slackThreadKey: "not-a-key" }),
      "malformed slack thread key",
    ],
  ])("settles failed when %s", async (_what, run, expectedError) => {
    const world = fakeWorld();
    world.runs.set(run.runId, run);
    world.integrations.set(INTEGRATION_ID, slackIntegration());
    const outcome = await service(world).deliver({
      runId: run.runId,
      status: "succeeded",
      // Give routing failures a reply so they reach their own check.
      lastAssistantMessage: expectedError.includes("reply") ? null : "reply",
    });
    expect(outcome).toBe("failed");
    expect(world.posts).toHaveLength(0);
    expect(world.deliveries[0]!.error).toContain(expectedError);
  });

  test("settles failed when the integration is disconnected", async () => {
    const world = fakeWorld();
    world.runs.set("run-1", slackRun());
    const outcome = await service(world).deliver({
      runId: "run-1",
      status: "succeeded",
      lastAssistantMessage: "reply",
    });
    expect(outcome).toBe("failed");
    expect(world.deliveries[0]!.error).toContain("disconnected");
  });

  test("settles failed when the master key is unavailable (no plaintext leak)", async () => {
    const world = fakeWorld();
    world.runs.set("run-1", slackRun());
    world.integrations.set(INTEGRATION_ID, slackIntegration());
    const outcome = await service(world, null).deliver({
      runId: "run-1",
      status: "succeeded",
      lastAssistantMessage: "reply",
    });
    expect(outcome).toBe("failed");
    expect(world.posts).toHaveLength(0);
    expect(world.deliveries[0]!.error).toContain("master key");
  });

  test("a Slack API error settles failed with the Slack error", async () => {
    const world = fakeWorld({ postResult: { ok: false, error: "channel_not_found" } });
    world.runs.set("run-1", slackRun());
    world.integrations.set(INTEGRATION_ID, slackIntegration());
    const outcome = await service(world).deliver({
      runId: "run-1",
      status: "succeeded",
      lastAssistantMessage: "reply",
    });
    expect(outcome).toBe("failed");
    expect(world.deliveries[0]!.error).toContain("channel_not_found");
    expect(world.outcomes).toEqual(["failed"]);
  });

  test("IM sessions (thread key third part = channel) thread on the envelope ts", async () => {
    const world = fakeWorld();
    world.runs.set(
      "run-1",
      slackRun({
        slackThreadKey: `${INTEGRATION_ID}:D-DM:D-DM`,
        triggerData: { channel: "D-DM", ts: "1720000500.000500", thread_ts: "1720000500.000500" },
      }),
    );
    world.integrations.set(INTEGRATION_ID, slackIntegration());
    await service(world).deliver({
      runId: "run-1",
      status: "succeeded",
      lastAssistantMessage: "dm reply",
    });
    expect(world.posts[0]).toMatchObject({
      channel: "D-DM",
      threadTs: "1720000500.000500",
    });
  });
});

// ── recovery sweep ───────────────────────────────────────────────────────────

describe("DeliveryService.recoverPending", () => {
  test("delivers succeeded+pending runs from persisted events; leaves others alone", async () => {
    const world = fakeWorld();
    world.integrations.set(INTEGRATION_ID, slackIntegration());
    world.runs.set("stuck", slackRun({ runId: "stuck" }));
    world.events.set("stuck", [stopEvent("late but delivered")]);
    // Not in scope: still running, already settled, no delivery owed.
    world.runs.set("running", slackRun({ runId: "running", runStatus: "running" }));
    world.runs.set("settled", slackRun({ runId: "settled", deliveryStatus: "delivered" }));
    world.runs.set("chat", slackRun({ runId: "chat", deliveryStatus: null }));

    const tally = await service(world).recoverPending();

    expect(tally).toEqual({ delivered: 1, failed: 0, skipped: 0 });
    expect(world.posts).toHaveLength(1);
    expect(world.posts[0]!.text).toBe("late but delivered");
    expect(world.runs.get("stuck")!.deliveryStatus).toBe("delivered");
    expect(world.runs.get("running")!.deliveryStatus).toBe("pending");
  });

  test("a stuck run with no recoverable reply settles failed", async () => {
    const world = fakeWorld();
    world.integrations.set(INTEGRATION_ID, slackIntegration());
    world.runs.set("stuck", slackRun({ runId: "stuck" }));
    const tally = await service(world).recoverPending();
    expect(tally).toEqual({ delivered: 0, failed: 1, skipped: 0 });
    expect(world.runs.get("stuck")!.deliveryStatus).toBe("failed");
  });
});
