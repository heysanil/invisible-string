/**
 * Outbound reply delivery (agents-first redesign §5.5) — the control plane
 * posts a run's final assistant reply back to the trigger surface that owes
 * one. Slack is the only such surface today (webhook/form callbacks were dead
 * code and are gone; chat streams over SSE).
 *
 * Compiled agents used to post Slack replies themselves from a generated
 * trigger channel (`emitSlackLib`, deleted with compiler v3.0.0) — which
 * required injecting SLACK_BOT_TOKEN into agent env and silently broke on
 * warm processes (env only lands at spawn). Delivery now lives entirely
 * control-plane-side, driven by the run ledger:
 *
 * - DISPATCH marks slack-origin runs `delivery_status = pending` (dispatch.ts).
 * - The TAILER's RunFinishedHook carries the run's last stop-message;
 *   {@link DeliveryService.deliver} posts it as a threaded chat.postMessage
 *   (same payload shape the dead codegen used) and settles the marker.
 * - Paths that mark a run TERMINAL outside the tailer hook (failDispatch,
 *   the dispatch-time allowlist failure, run cancel without a live tail, the
 *   sweeper's no-eve-session fail) call deliver() themselves so the pending
 *   marker settles at the moment of failure, not at the next boot.
 * - BOOT RECOVERY ({@link DeliveryService.recoverPending}, called from
 *   reconcileInterruptedRuns): TERMINAL runs stuck `pending` (control plane
 *   crashed between terminal event and delivery, or terminal rows written by
 *   older code) either recover their reply from the persisted `run_events`
 *   and deliver late (succeeded) or settle the ledger (failed/canceled).
 *
 * Semantics are AT-LEAST-ONCE (documented residual): the Slack post happens
 * before the marker flips, so a crash in between re-delivers on recovery. The
 * marker itself is CAS'd (only `pending` settles) so racing settlers resolve
 * to one ledger writer.
 *
 * Secrets discipline: the bot token is decrypted in-process, passed straight
 * to the Slack client, and never logged (reply text is user content — also
 * never logged).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type {
  DeliveryStatus,
  EveStreamEvent,
  Logger,
  MasterKey,
  RunStatus,
  SessionOrigin,
} from "@invisible-string/shared";

import type { Db } from "../db";
import {
  decryptIntegrationCredentials,
  type SlackStoredCredentials,
} from "../integrations/crypto";
import type { SlackClient } from "../integrations/slack-client";
import type { RunStore } from "./store";

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * The last `message.completed` with `finishReason: "stop"` — the run's final
 * assistant reply. Used by boot recovery over persisted `run_events`; taking
 * the LAST match makes leftover stop-messages drained from a previous turn
 * harmless (this run's own reply lands after them). Pure.
 */
export function lastStopMessageFrom(
  events: readonly EveStreamEvent[],
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (
      event.type === "message.completed" &&
      event.data.finishReason === "stop" &&
      typeof event.data.message === "string"
    ) {
      return event.data.message;
    }
  }
  return null;
}

export interface ParsedSlackThreadKey {
  integrationId: string;
  channel: string;
  threadTs: string;
}

/**
 * Split a session's `slack_thread_key` (`<integrationId>:<channel>:<threadTs>`
 * — see dispatch.ts slackThreadKey). Pure; null when malformed.
 */
export function parseSlackThreadKey(key: string): ParsedSlackThreadKey | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  const [integrationId, channel, threadTs] = parts as [string, string, string];
  if (!integrationId || !channel || !threadTs) return null;
  return { integrationId, channel, threadTs };
}

export interface SlackReplyTarget {
  channel: string | null;
  threadTs: string | null;
}

/**
 * Reply routing from the run's TriggerEvent `data` (the Slack adapter keeps
 * `channel`/`thread_ts`/`ts` in the envelope for exactly this) — ported from
 * the dead codegen's `replyTargetFrom`. Pure.
 */
export function slackReplyTargetFrom(
  data: Record<string, unknown>,
): SlackReplyTarget {
  const channel = typeof data.channel === "string" ? data.channel : null;
  const threadTs =
    typeof data.thread_ts === "string"
      ? data.thread_ts
      : typeof data.ts === "string"
        ? data.ts
        : null;
  return { channel, threadTs };
}

// ── Reader (interface-first, like RunStore) ──────────────────────────────────

/** The run + session slice delivery consumes. */
export interface DeliverableRun {
  runId: string;
  runStatus: RunStatus;
  deliveryStatus: DeliveryStatus | null;
  organizationId: string;
  origin: SessionOrigin;
  /** `<integrationId>:<channel>:<threadTs>` for slack sessions; else null. */
  slackThreadKey: string | null;
  /** TriggerEvent `data` (reply routing lives here). */
  triggerData: Record<string, unknown>;
}

export interface DeliveryIntegration {
  id: string;
  type: string;
  /** Slack team id — the AAD the credentials were encrypted under. */
  externalId: string;
  credentialsEncrypted: string;
}

/**
 * DB reads the delivery service needs. Interface-first so delivery.test.ts
 * runs against an in-memory fake; the drizzle impl is production.
 */
export interface DeliveryReader {
  loadRun(runId: string): Promise<DeliverableRun | null>;
  loadIntegration(integrationId: string): Promise<DeliveryIntegration | null>;
  /**
   * Recovery sweep scope: TERMINAL runs (succeeded/failed/canceled) whose
   * delivery is still pending. Succeeded runs deliver late; failed/canceled
   * runs settle the ledger — a run that failed before its tail ever started
   * must not report a pending delivery forever.
   */
  listPendingTerminalRuns(): Promise<Array<{ id: string; status: RunStatus }>>;
  /** Persisted run events (seq order) — recovery recovers the reply here. */
  listRunEvents(runId: string): Promise<EveStreamEvent[]>;
}

export function createDrizzleDeliveryReader(db: Db): DeliveryReader {
  return {
    async loadRun(runId) {
      const rows = await db
        .select({ run: schema.runs, session: schema.agentSessions })
        .from(schema.runs)
        .innerJoin(
          schema.agentSessions,
          eq(schema.runs.agentSessionId, schema.agentSessions.id),
        )
        .where(eq(schema.runs.id, runId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const triggerEvent = row.run.triggerEvent as { data?: unknown };
      const data = triggerEvent?.data;
      return {
        runId: row.run.id,
        runStatus: row.run.status,
        deliveryStatus: row.run.deliveryStatus,
        organizationId: row.session.organizationId,
        origin: row.session.origin,
        slackThreadKey: row.session.slackThreadKey,
        triggerData:
          typeof data === "object" && data !== null && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : {},
      };
    },

    async loadIntegration(integrationId) {
      const rows = await db
        .select({
          id: schema.integrations.id,
          type: schema.integrations.type,
          externalId: schema.integrations.externalId,
          credentialsEncrypted: schema.integrations.credentialsEncrypted,
        })
        .from(schema.integrations)
        .where(eq(schema.integrations.id, integrationId))
        .limit(1);
      return rows[0] ?? null;
    },

    async listPendingTerminalRuns() {
      const rows = await db
        .select({ id: schema.runs.id, status: schema.runs.status })
        .from(schema.runs)
        .where(
          and(
            inArray(schema.runs.status, ["succeeded", "failed", "canceled"]),
            eq(schema.runs.deliveryStatus, "pending"),
          ),
        );
      return rows;
    },

    async listRunEvents(runId) {
      const rows = await db
        .select({ event: schema.runEvents.event })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, runId))
        .orderBy(asc(schema.runEvents.seq));
      return rows.map((row) => row.event as unknown as EveStreamEvent);
    },
  };
}

// ── The service ──────────────────────────────────────────────────────────────

export type DeliveryOutcome = "delivered" | "failed" | "skipped";

export interface DeliverInput {
  runId: string;
  /**
   * The run's terminal status as the caller observed it (the tailer hook's
   * status, or "succeeded" from recovery). The DB row is re-read and is
   * authoritative; this only lets non-terminal hook fires short-circuit.
   */
  status: RunStatus;
  /** The tailer-tracked final reply; null lets delivery recover it from run_events. */
  lastAssistantMessage: string | null;
}

export interface DeliveryService {
  /**
   * Settle one run's delivery obligation. No-op ("skipped") unless the run
   * owes a `pending` delivery and is terminal. Never throws — a failed
   * delivery is a `delivery_status = failed` row plus a warn log, never a
   * crashed tailer hook.
   */
  deliver(input: DeliverInput): Promise<DeliveryOutcome>;
  /**
   * Boot-time recovery sweep: every TERMINAL run stuck `pending` is settled
   * — succeeded runs recover their reply from persisted run_events and
   * deliver late (at-least-once); failed/canceled runs settle `failed`
   * (no reply owed).
   */
  recoverPending(): Promise<{ delivered: number; failed: number; skipped: number }>;
}

export interface DeliveryServiceDeps {
  reader: DeliveryReader;
  runStore: Pick<RunStore, "markDelivery">;
  slackClient: SlackClient;
  /** Envelope-decryption key; deliveries fail cleanly when absent. */
  masterKey: MasterKey | undefined;
  logger: Logger;
  /** Fleet counters (delivered/failed) — optional so tests stay lean. */
  onOutcome?: (outcome: Extract<DeliveryOutcome, "delivered" | "failed">) => void;
}

export function createDeliveryService(deps: DeliveryServiceDeps): DeliveryService {
  const { reader, runStore, slackClient, masterKey, logger } = deps;

  async function settleFailed(
    runId: string,
    organizationId: string | undefined,
    reason: string,
  ): Promise<DeliveryOutcome> {
    const settled = await runStore.markDelivery(runId, "failed", reason);
    if (settled) {
      deps.onOutcome?.("failed");
      logger.warn("delivery.failed", {
        runId,
        ...(organizationId ? { workspaceId: organizationId } : {}),
        fields: { reason },
      });
    }
    return settled ? "failed" : "skipped";
  }

  async function deliver(input: DeliverInput): Promise<DeliveryOutcome> {
    try {
      // Parked/queued/running hook fires leave the obligation pending — the
      // real terminal (after a HITL resume, for instance) settles it.
      if (
        input.status === "queued" ||
        input.status === "running" ||
        input.status === "waiting"
      ) {
        return "skipped";
      }

      const run = await reader.loadRun(input.runId);
      if (!run || run.deliveryStatus !== "pending") return "skipped";

      // The DB status is authoritative (the tailer marks the run before the
      // hook fires; recovery reads succeeded rows).
      if (run.runStatus === "queued" || run.runStatus === "running" || run.runStatus === "waiting") {
        return "skipped";
      }
      if (run.runStatus !== "succeeded") {
        // A failed/canceled run owes no reply — settle the ledger so the
        // recovery sweep never reconsiders it.
        return settleFailed(
          run.runId,
          run.organizationId,
          `run ${run.runStatus} — no reply delivered`,
        );
      }

      const text =
        input.lastAssistantMessage ??
        lastStopMessageFrom(await reader.listRunEvents(run.runId));
      if (text === null || text.length === 0) {
        return settleFailed(
          run.runId,
          run.organizationId,
          "run produced no terminal assistant reply (finishReason stop)",
        );
      }

      if (run.slackThreadKey === null) {
        return settleFailed(
          run.runId,
          run.organizationId,
          "session has no slack thread key — cannot route the reply",
        );
      }
      const key = parseSlackThreadKey(run.slackThreadKey);
      if (!key) {
        return settleFailed(
          run.runId,
          run.organizationId,
          "malformed slack thread key",
        );
      }

      const integration = await reader.loadIntegration(key.integrationId);
      if (!integration || integration.type !== "slack") {
        return settleFailed(
          run.runId,
          run.organizationId,
          "slack integration disconnected — reply undeliverable",
        );
      }
      if (masterKey === undefined) {
        return settleFailed(
          run.runId,
          run.organizationId,
          "encryption master key unavailable — cannot decrypt the bot token",
        );
      }

      let botToken: string;
      try {
        const plaintext = decryptIntegrationCredentials(
          integration.credentialsEncrypted,
          masterKey,
          "slack",
          integration.externalId,
        );
        botToken = (JSON.parse(plaintext) as SlackStoredCredentials).botToken;
      } catch {
        return settleFailed(
          run.runId,
          run.organizationId,
          "failed to decrypt slack credentials",
        );
      }

      // Reply target: the envelope's channel/thread_ts (kept by the Slack
      // adapter for delivery), with the thread-key parts as fallback.
      const target = slackReplyTargetFrom(run.triggerData);
      const channel = target.channel ?? key.channel;
      const threadTs = target.threadTs ?? key.threadTs;

      const posted = await slackClient.postMessage({
        token: botToken,
        channel,
        text,
        threadTs,
      });
      if (!posted.ok) {
        return settleFailed(
          run.runId,
          run.organizationId,
          `chat.postMessage failed: ${posted.error}`,
        );
      }

      const settled = await runStore.markDelivery(run.runId, "delivered");
      if (settled) {
        deps.onOutcome?.("delivered");
        logger.info("delivery.delivered", {
          runId: run.runId,
          workspaceId: run.organizationId,
          fields: { channel, threaded: true },
        });
      }
      return settled ? "delivered" : "skipped";
    } catch (error) {
      // Never let a delivery problem crash the tailer hook or boot recovery.
      logger.error("delivery.failed", {
        runId: input.runId,
        err: error,
        fields: { reason: "unexpected delivery error" },
      });
      return "failed";
    }
  }

  return {
    deliver,

    async recoverPending() {
      const tally = { delivered: 0, failed: 0, skipped: 0 };
      const stuck = await reader.listPendingTerminalRuns();
      for (const run of stuck) {
        const outcome = await deliver({
          runId: run.id,
          status: run.status,
          lastAssistantMessage: null,
        });
        tally[outcome] += 1;
      }
      if (stuck.length > 0) {
        logger.info("delivery.recovered", { fields: { ...tally } });
      }
      return tally;
    },
  };
}
