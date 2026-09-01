/**
 * Outbound reply delivery — the control plane posts a run's reply back to the
 * trigger surface that owes one. Slack is the only such surface today
 * (webhook/form callbacks were dead code and are gone; chat streams over SSE).
 *
 * PIPELINES GET EXPLICIT DELIVERY ONLY (workflow-pipelines redesign): the one
 * writer of `delivery_status = 'pending'` is the pipeline run creator, for
 * slack-origin PARENT runs whose config declares `onComplete.slackReply`. The
 * old implicit "post the run's last assistant stop-message" path served only
 * workflow-dispatched agent runs and is REMOVED with them — a pipeline has no
 * well-defined final assistant message, and its `agent`-step CHILD runs never
 * deliver (their `delivery_status` stays null by construction). Chat runs
 * never owed a reply in the first place.
 *
 * - The PIPELINE RUNNER's terminal path renders the `onComplete.slackReply`
 *   template against the final run scope and passes it here as
 *   `lastAssistantMessage`; {@link DeliveryService.deliver} posts it as a
 *   threaded chat.postMessage and settles the marker.
 * - Paths that mark a pipeline run TERMINAL outside the runner (the routes
 *   cancel fallback, recovery's failOutright) call deliver() themselves so
 *   the pending marker settles at the moment of failure, not at the next
 *   boot. deliver() no-ops for runs owing nothing.
 * - BOOT RECOVERY ({@link DeliveryService.recoverPending}, called from
 *   reconcileInterruptedRuns): TERMINAL runs stuck `pending` (control plane
 *   crashed between terminal status and the Slack post) either RE-RENDER the
 *   reply from the persisted `run_steps` ledger + workflow state
 *   ({@link DeliveryReader.loadPipelineRenderContext}) and deliver late
 *   (succeeded) or settle the ledger (failed/canceled).
 *
 * Reply ROUTING for a pipeline run comes off the run row alone — no session
 * exists: the Slack ingress stamps the thread key into
 * `TriggerEvent.data.slackThreadKey`, and the envelope's `channel`/
 * `thread_ts`/`ts` fields carry the post target (the same fields the session
 * path used).
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
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  renderMarkdownTemplate,
  workflowConfigSchema,
  type DeliveryStatus,
  type EveStreamEvent,
  type Logger,
  type MasterKey,
  type PipelineScope,
  type RunMode,
  type RunStatus,
} from "@invisible-string/shared";

import type { Db } from "../db";
import {
  decryptIntegrationCredentials,
  type SlackStoredCredentials,
} from "../integrations/crypto";
import type { SlackClient } from "../integrations/slack-client";
import { rebuildScopeSteps } from "../pipeline/plan";
import type { RunStore } from "./store";

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * The last `message.completed` with `finishReason: "stop"` — a run's final
 * assistant reply. No longer part of DELIVERY (pipelines deliver an explicit
 * rendered template), but still the extraction rule for an `agent` step
 * reading its CHILD run's terminal reply (pipeline/steps/agent.ts). Taking
 * the LAST match makes leftover stop-messages drained from a previous turn
 * harmless. Pure.
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
 * Split a Slack thread key (`<integrationId>:<channel>:<threadTs>` — see
 * dispatch.ts slackThreadKey). For pipeline runs it arrives on the envelope's
 * `data.slackThreadKey`; for agent-step child sessions it lives on
 * `agent_sessions.slack_thread_key`. Pure; null when malformed.
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
 * `channel`/`thread_ts`/`ts` in the envelope for exactly this). Pure.
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

/** The run slice delivery consumes. */
export interface DeliverableRun {
  runId: string;
  mode: RunMode;
  runStatus: RunStatus;
  deliveryStatus: DeliveryStatus | null;
  organizationId: string;
  /**
   * `<integrationId>:<channel>:<threadTs>`. For pipeline runs this is the
   * envelope's `data.slackThreadKey` (no session exists); a session-carried
   * key wins when present (agent-mode rows).
   */
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
 * Everything a late (recovery) render of `onComplete.slackReply` needs: the
 * published template plus the scope REBUILT from the run's persisted step
 * ledger and the workflow's current state.
 */
export interface PipelineRenderContext {
  templateMarkdown: string;
  scope: PipelineScope;
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
   * delivery is still pending. Succeeded runs re-render + deliver late;
   * failed/canceled runs settle the ledger — a run that failed before its
   * driver settled must not report a pending delivery forever.
   */
  listPendingTerminalRuns(): Promise<Array<{ id: string; status: RunStatus }>>;
  /**
   * Recovery's re-render source for a pipeline run: the workflow's published
   * `onComplete.slackReply` template + the scope rebuilt from `run_steps`
   * and workflow state. Null when the workflow (or its template) is gone —
   * the obligation then settles `failed`.
   */
  loadPipelineRenderContext(runId: string): Promise<PipelineRenderContext | null>;
}

export function createDrizzleDeliveryReader(db: Db): DeliveryReader {
  return {
    async loadRun(runId) {
      // LEFT join (pipelines join audit): pipeline runs have NO session — an
      // inner join would hide exactly the runs that owe deliveries now.
      const rows = await db
        .select({ run: schema.runs, session: schema.agentSessions })
        .from(schema.runs)
        .leftJoin(
          schema.agentSessions,
          eq(schema.runs.agentSessionId, schema.agentSessions.id),
        )
        .where(eq(schema.runs.id, runId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const triggerEvent = row.run.triggerEvent as { data?: unknown };
      const data = triggerEvent?.data;
      const triggerData =
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {};
      const organizationId =
        row.run.organizationId ?? row.session?.organizationId ?? "";
      const envelopeThreadKey = triggerData["slackThreadKey"];
      return {
        runId: row.run.id,
        mode: row.run.mode,
        runStatus: row.run.status,
        deliveryStatus: row.run.deliveryStatus,
        organizationId,
        slackThreadKey:
          row.session?.slackThreadKey ??
          (typeof envelopeThreadKey === "string" && envelopeThreadKey.length > 0
            ? envelopeThreadKey
            : null),
        triggerData,
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

    async loadPipelineRenderContext(runId) {
      const runRows = await db
        .select({
          workflowId: schema.runs.workflowId,
          triggerEvent: schema.runs.triggerEvent,
          startedAt: schema.runs.startedAt,
          createdAt: schema.runs.createdAt,
        })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .limit(1);
      const run = runRows[0];
      if (!run?.workflowId) return null;

      const workflowRows = await db
        .select({ published: schema.workflows.published })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, run.workflowId))
        .limit(1);
      const published = workflowRows[0]?.published;
      if (!published) return null;
      const parsed = workflowConfigSchema.safeParse(published);
      const templateMarkdown =
        parsed.success
          ? parsed.data.onComplete?.slackReply?.template.markdown
          : undefined;
      if (templateMarkdown === undefined) return null;

      const stepRows = await db
        .select()
        .from(schema.runSteps)
        .where(eq(schema.runSteps.runId, runId));
      const stateRows = await db
        .select({
          key: schema.workflowState.key,
          value: schema.workflowState.value,
        })
        .from(schema.workflowState)
        .where(eq(schema.workflowState.workflowId, run.workflowId));

      const triggerEvent = run.triggerEvent as { data?: unknown };
      const data = triggerEvent?.data;
      const scope: PipelineScope = {
        trigger:
          typeof data === "object" && data !== null && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : {},
        steps: rebuildScopeSteps(stepRows),
        // CURRENT state, not the exact end-of-run snapshot — the run's own
        // writes are already in it, and a later run's overwrite is an
        // accepted recovery approximation (documented, at-least-once lane).
        state: Object.fromEntries(
          stateRows.map((row) => [row.key, row.value as unknown]),
        ),
        now: (run.startedAt ?? run.createdAt).toISOString(),
      };
      return { templateMarkdown, scope };
    },
  };
}

// ── The service ──────────────────────────────────────────────────────────────

export type DeliveryOutcome = "delivered" | "failed" | "skipped";

export interface DeliverInput {
  runId: string;
  /**
   * The run's terminal status as the caller observed it (the runner's
   * terminal path, or the recovery sweep). The DB row is re-read and is
   * authoritative; this only lets non-terminal calls short-circuit.
   */
  status: RunStatus;
  /**
   * The ALREADY-RENDERED `onComplete.slackReply` text (the runner renders
   * against the live final scope); null lets delivery re-render from the
   * persisted ledger (boot recovery).
   */
  lastAssistantMessage: string | null;
}

export interface DeliveryService {
  /**
   * Settle one run's delivery obligation. No-op ("skipped") unless the run
   * owes a `pending` delivery and is terminal. Never throws — a failed
   * delivery is a `delivery_status = failed` row plus a warn log, never a
   * crashed runner terminal path.
   */
  deliver(input: DeliverInput): Promise<DeliveryOutcome>;
  /**
   * Boot-time recovery sweep: every TERMINAL run stuck `pending` is settled
   * — succeeded pipeline runs re-render their reply from the persisted
   * `run_steps` scope and deliver late (at-least-once); failed/canceled runs
   * settle `failed` (no reply owed).
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

  /**
   * Settle the ledger as `failed` and say why. EVERY call site inside
   * {@link deliver} must `return await` this — a bare `return settleFailed(…)`
   * inside the try block adopts the promise only AFTER the block exits, so
   * deliver's own catch never sees a rejected settle write and the failure
   * escapes the function that documents "never throws". The tailer hook fires
   * delivery as `void delivery.deliver(info)` (index.ts), so what escapes is
   * an unhandled rejection in the process — and the settle write is exactly
   * the call that rejects in practice: `close()` awaits `tailers.stopAll()`
   * (which finishes the live runs and starts their deliveries) and then ends
   * the pool underneath the in-flight update, which surfaced intermittently
   * as `Failed query: update "runs" set "delivery_status" … CONNECTION_ENDED`.
   */
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
      // Parked/queued/running calls leave the obligation pending — the real
      // terminal (after an agent-step park resumes, for instance) settles it.
      if (
        input.status === "queued" ||
        input.status === "running" ||
        input.status === "waiting"
      ) {
        return "skipped";
      }

      const run = await reader.loadRun(input.runId);
      if (!run || run.deliveryStatus !== "pending") return "skipped";

      // The DB status is authoritative (the runner marks the run before it
      // calls deliver; recovery reads terminal rows).
      if (run.runStatus === "queued" || run.runStatus === "running" || run.runStatus === "waiting") {
        return "skipped";
      }
      if (run.runStatus !== "succeeded") {
        // A failed/canceled run owes no reply — settle the ledger so the
        // recovery sweep never reconsiders it.
        return await settleFailed(
          run.runId,
          run.organizationId,
          `run ${run.runStatus} — no reply delivered`,
        );
      }

      // The reply text: the runner's live render, or a recovery re-render
      // from the persisted ledger. Only pipelines owe deliveries — there is
      // no implicit last-assistant-message fallback anymore.
      let text = input.lastAssistantMessage;
      if (text === null) {
        const context = await reader.loadPipelineRenderContext(run.runId);
        if (context) {
          text = renderMarkdownTemplate(context.templateMarkdown, context.scope);
        }
      }
      if (text === null || text.length === 0) {
        return await settleFailed(
          run.runId,
          run.organizationId,
          "no onComplete.slackReply template could be rendered for this run",
        );
      }

      if (run.slackThreadKey === null) {
        return await settleFailed(
          run.runId,
          run.organizationId,
          "run has no slack thread key — cannot route the reply",
        );
      }
      const key = parseSlackThreadKey(run.slackThreadKey);
      if (!key) {
        return await settleFailed(
          run.runId,
          run.organizationId,
          "malformed slack thread key",
        );
      }

      const integration = await reader.loadIntegration(key.integrationId);
      if (!integration || integration.type !== "slack") {
        return await settleFailed(
          run.runId,
          run.organizationId,
          "slack integration disconnected — reply undeliverable",
        );
      }
      if (masterKey === undefined) {
        return await settleFailed(
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
        return await settleFailed(
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
        return await settleFailed(
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
      // Never let a delivery problem crash the runner terminal path or boot
      // recovery.
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
