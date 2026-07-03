/**
 * Trigger ingress + integrations + trigger-binding HTTP surface (docs/PLAN.md
 * Phase 3 task 3). Mounted only when the runtime is configured (dispatch needs
 * workers + artifacts).
 *
 * PUBLIC (token/signature authenticated, no session):
 * - POST /t/:token                    webhook + form ingress → dispatcher
 * - POST /integrations/slack/events   Slack Events API (verify → route → dispatch)
 * - GET  /integrations/slack/callback OAuth redirect-back (state-signed)
 *
 * WORKSPACE-SCOPED (Better Auth session, IDOR-guarded):
 * - GET/DELETE /workspaces/:id/integrations[...]         list / disconnect
 * - GET  /workspaces/:id/integrations/slack/install      → 302 Slack consent
 * - GET  /workspaces/:id/workflows/:wfId/triggers        list bindings
 * - POST /workspaces/:id/workflows/:wfId/triggers/webhook-token   mint (ONCE)
 * - POST /workspaces/:id/workflows/:wfId/triggers/:id/rotate-token rotate
 * - PUT  /workspaces/:id/workflows/:wfId/triggers/slack           bind Slack
 */
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import {
  formSubmissionToTriggerData,
  makeLogEvent,
  parseWorkflowDraft,
  slackEventToTriggerData,
  slackTriggerBindingSchema,
  slackWebhookBodySchema,
  updateSlackTriggerBindingRequestSchema,
  TRIGGER_INGRESS_MAX_BODY_BYTES,
  SLACK_REPLAY_WINDOW_SECONDS,
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  type CreateWebhookTokenResponse,
  type GetTriggerBindingResponse,
  type ListIntegrationsResponse,
  type ListTriggerBindingsResponse,
  type LogEventName,
  type SlackInnerEvent,
  type SlackIntegrationMetadata,
  type SlackTriggerBinding,
  type TriggerIngressResponse,
  type TriggerPrincipal,
} from "@invisible-string/shared";

import { workspacePlugin } from "../workspace";
import { errors, isRuntimeApiError } from "../runtime/errors";
import {
  dispatchTriggerRun,
  findSlackThreadSession,
  slackThreadKey,
  type DispatchTriggerInput,
} from "../runtime/dispatch";
import { requireReadyVersion, type ReadyVersion, type RuntimeDeps } from "../runtime/routes";
import {
  ingressUrlForToken,
  slackRedirectUri,
  type IntegrationsConfig,
} from "./config";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  type SlackStoredCredentials,
} from "./crypto";
import type { FixedWindowRateLimiter } from "./rate-limit";
import {
  deleteIntegration,
  findIntegration,
  findSlackIntegrationByTeam,
  integrationDto,
  listIntegrations,
  listSlackTriggersForIntegration,
  listTriggers,
  resolveTriggerByTokenHash,
  setSlackBinding,
  setTriggerToken,
  triggerBindingDto,
  upsertSlackIntegration,
  upsertTriggerType,
} from "./service";
import { buildSlackInstallUrl, signOAuthState, verifyOAuthState } from "./slack-oauth";
import type { SlackClient } from "./slack-client";
import { SlackEventDedup, verifySlackRequest } from "./slack-verify";
import { hashIngressToken, generateIngressToken, tokenSuffix } from "./tokens";

type WorkflowRow = typeof schema.workflows.$inferSelect;

export interface IntegrationDeps {
  runtime: RuntimeDeps;
  config: IntegrationsConfig;
  slackClient: SlackClient;
  /** Per-token ingress budget. */
  tokenRateLimiter: FixedWindowRateLimiter;
  /** Per-IP ingress budget. */
  ipRateLimiter: FixedWindowRateLimiter;
  /** Slack retry idempotency (dedup by event_id). */
  slackDedup: SlackEventDedup;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function log(level: "info" | "warn" | "error", event: LogEventName, fields: Record<string, unknown>): void {
  // Structured, redaction-safe (no secrets, no raw payloads) — see
  // packages/shared observability contract.
  console.log(
    JSON.stringify(
      makeLogEvent({
        level,
        event,
        fields: fields as Record<string, string | number | boolean | null>,
      }),
    ),
  );
}

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Pure: does an inbound Slack event start a NEW session under this binding? */
export function shouldStartNewSlackSession(
  event: SlackInnerEvent,
  binding: SlackTriggerBinding,
): boolean {
  if (binding.channelId && event.channel !== binding.channelId) return false;
  if (event.type === "app_mention") return true;
  if (event.channel_type === "im") return binding.includeDirectMessages;
  // A non-mention channel/group message only starts a session when the binding
  // is not mention-only (thread replies to a KNOWN session continue it
  // regardless — that check happens before this one).
  return !binding.mentionOnly;
}

// ── plugin ───────────────────────────────────────────────────────────────────

export function integrationsPlugin(deps: IntegrationDeps) {
  const { runtime, config } = deps;
  const db = runtime.db;
  const masterKey = runtime.masterKey;

  // Webhook idempotency: a source-provided key (Idempotency-Key /
  // X-Idempotency-Key header) makes redelivery return the SAME run instead of
  // starting a duplicate. Bounded in-process cache (single control-plane node).
  const idempotency = new Map<string, { runId: string; sessionId: string }>();
  const IDEMPOTENCY_MAX = 10_000;
  const rememberIdempotent = (key: string, value: { runId: string; sessionId: string }) => {
    idempotency.set(key, value);
    if (idempotency.size > IDEMPOTENCY_MAX) {
      const first = idempotency.keys().next().value;
      if (first !== undefined) idempotency.delete(first);
    }
  };

  async function loadWorkflowOwned(
    organizationId: string,
    workflowId: string,
  ): Promise<WorkflowRow> {
    const rows = await db
      .select()
      .from(schema.workflows)
      .where(
        and(
          eq(schema.workflows.id, workflowId),
          eq(schema.workflows.organizationId, organizationId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw errors.workflowNotFound();
    return row;
  }

  return (
    new Elysia({ name: "integrations" })
      .use(workspacePlugin(runtime.workspaceDeps))
      .onError(({ error, set }) => {
        if (isRuntimeApiError(error)) {
          set.status = error.status;
          return error.toBody();
        }
        return undefined;
      })

      // ── PUBLIC: webhook + form ingress ────────────────────────────────────
      .post(
        "/t/:token",
        async ({ params, request, set }): Promise<TriggerIngressResponse> => {
          const raw = await request.text();
          if (Buffer.byteLength(raw, "utf8") > TRIGGER_INGRESS_MAX_BODY_BYTES) {
            throw errors.triggerPayloadTooLarge(TRIGGER_INGRESS_MAX_BODY_BYTES);
          }
          const token = params.token;
          const ip = clientIp(request);
          const ipDecision = deps.ipRateLimiter.hit(`ip:${ip}`);
          if (!ipDecision.allowed) {
            set.headers["retry-after"] = String(ipDecision.retryAfterSeconds);
            throw errors.rateLimited(ipDecision.retryAfterSeconds);
          }
          const tokenDecision = deps.tokenRateLimiter.hit(`tok:${token}`);
          if (!tokenDecision.allowed) {
            set.headers["retry-after"] = String(tokenDecision.retryAfterSeconds);
            throw errors.rateLimited(tokenDecision.retryAfterSeconds);
          }

          // Constant-time-ish hash lookup: the plaintext token is never stored
          // or compared — we hash the presented token and match the unique
          // token_hash index. Unknown/disabled tokens 404 (existence-hiding).
          const found = await resolveTriggerByTokenHash(db, hashIngressToken(token));
          if (!found || !found.trigger.enabled) {
            log("warn", "trigger.rejected", { reason: "unknown_or_disabled_token" });
            throw errors.triggerNotFound();
          }
          const { trigger, workflow } = found;
          if (trigger.type !== "webhook" && trigger.type !== "form") {
            throw errors.triggerNotFound();
          }

          let bodyJson: unknown = {};
          if (raw.trim().length > 0) {
            try {
              bodyJson = JSON.parse(raw);
            } catch {
              throw errors.formValidationFailed("request body is not valid JSON");
            }
          }

          if (!workflow.publishedVersionId) throw errors.workflowNotPublished();
          const ready = await requireReadyVersion(runtime, workflow.publishedVersionId);

          // Idempotency (webhook only): a source key maps redelivery to the
          // original run.
          const idemKey =
            request.headers.get("idempotency-key") ??
            request.headers.get("x-idempotency-key");
          if (idemKey) {
            const prior = idempotency.get(`${trigger.id}:${idemKey}`);
            if (prior) {
              set.status = 202;
              return { accepted: true, runId: prior.runId, sessionId: prior.sessionId };
            }
          }

          const { message, data } = mapIngressBody(trigger.type, bodyJson, ready);

          const principal: TriggerPrincipal = {
            workspaceId: workflow.organizationId,
            source: trigger.type,
          };
          log("info", "trigger.received", {
            workflowId: workflow.id,
            triggerType: trigger.type,
          });

          const result = await dispatchTriggerRun(runtime, {
            organizationId: workflow.organizationId,
            workflowId: workflow.id,
            ready,
            origin: trigger.type,
            triggerType: trigger.type,
            principal,
            message,
            data,
          });

          if (idemKey) {
            rememberIdempotent(`${trigger.id}:${idemKey}`, {
              runId: result.run.id,
              sessionId: result.session.id,
            });
          }
          log(result.dispatched ? "info" : "warn", result.dispatched ? "dispatch.delivered" : "dispatch.failed", {
            workflowId: workflow.id,
            runId: result.run.id,
            sessionId: result.session.id,
          });

          set.status = 202;
          return { accepted: true, runId: result.run.id, sessionId: result.session.id };
        },
        { parse: "none" },
      )

      // ── PUBLIC: Slack Events API ──────────────────────────────────────────
      .post(
        "/integrations/slack/events",
        async ({ request, set }) => {
          const raw = await request.text();
          if (!config.slack) {
            throw errors.integrationNotConfigured("slack");
          }
          // Signature + replay window FIRST (before any parsing/routing).
          const verify = verifySlackRequest({
            signingSecret: config.slack.signingSecret,
            signature: request.headers.get(SLACK_SIGNATURE_HEADER),
            timestamp: request.headers.get(SLACK_TIMESTAMP_HEADER),
            rawBody: raw,
            replayWindowSeconds: SLACK_REPLAY_WINDOW_SECONDS,
          });
          if (!verify.ok) {
            log("warn", "trigger.rejected", { source: "slack", reason: verify.reason });
            set.status = 401;
            return { error: { code: "slack_signature_invalid", message: "signature verification failed" } };
          }

          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            set.status = 400;
            return { error: { code: "invalid_body", message: "not JSON" } };
          }
          const bodyResult = slackWebhookBodySchema.safeParse(parsedBody);
          if (!bodyResult.success) {
            // Unknown top-level types (app_rate_limited, etc.) — 200-ack so
            // Slack does not retry indefinitely.
            return { ok: true };
          }
          const body = bodyResult.data;

          if (body.type === "url_verification") {
            return { challenge: body.challenge };
          }

          // event_callback — dedup Slack retries by event_id.
          if (body.event_id && !deps.slackDedup.markSeen(body.event_id)) {
            return { ok: true };
          }

          // Ack Slack FAST (3s budget) and dispatch in the background — the run
          // streams via the normal SSE surface; a slow ensure-agent must not
          // hold the webhook open. Failures are logged, never surfaced to Slack.
          void routeSlackEvent(body.team_id, body.event).catch((error) => {
            log("error", "dispatch.failed", {
              source: "slack",
              reason: error instanceof Error ? error.message : String(error),
            });
          });
          return { ok: true };
        },
        { parse: "none" },
      )

      // ── PUBLIC: Slack OAuth callback (state-signed) ───────────────────────
      .get("/integrations/slack/callback", async ({ query, set }) => {
        const settingsUrl = `${config.publicAppUrl}/settings`;
        const redirectTo = (url: string) => {
          set.status = 302;
          set.headers["location"] = url;
        };
        if (!config.slack) throw errors.integrationNotConfigured("slack");
        if (typeof query.error === "string" && query.error.length > 0) {
          redirectTo(`${settingsUrl}?slack=denied`);
          return;
        }
        const code = typeof query.code === "string" ? query.code : "";
        const state = typeof query.state === "string" ? query.state : "";
        const workspaceId = verifyOAuthState(config.stateSecret, state);
        if (!code || !workspaceId) throw errors.slackStateInvalid();

        const exchange = await deps.slackClient.exchangeOAuthCode({
          clientId: config.slack.clientId,
          clientSecret: config.slack.clientSecret,
          code,
          redirectUri: slackRedirectUri(config.publicAppUrl),
        });
        if (!exchange.ok) throw errors.slackOAuthFailed(exchange.error);

        const access = exchange.value;
        const credentials: SlackStoredCredentials = { botToken: access.access_token };
        const metadata: SlackIntegrationMetadata = {
          teamName: access.team.name,
          botUserId: access.bot_user_id,
          scopes: access.scope ? access.scope.split(/[\s,]+/).filter((s) => s.length > 0) : [],
        };
        await upsertSlackIntegration(db, {
          organizationId: workspaceId,
          teamId: access.team.id,
          credentialsEncrypted: encryptIntegrationCredentials(
            JSON.stringify(credentials),
            masterKey,
            "slack",
            access.team.id,
          ),
          metadata,
        });
        log("info", "trigger.received", { source: "slack.install", workspaceId });
        redirectTo(`${settingsUrl}?slack=connected`);
      })

      // ── Slack install (workspace-scoped; admin) ───────────────────────────
      .get(
        "/workspaces/:workspaceId/integrations/slack/install",
        ({ workspace, set }) => {
          if (!config.slack) throw errors.integrationNotConfigured("slack");
          const state = signOAuthState(config.stateSecret, workspace.organizationId);
          set.status = 302;
          set.headers["location"] = buildSlackInstallUrl({
            clientId: config.slack.clientId,
            scopes: config.slack.scopes,
            redirectUri: slackRedirectUri(config.publicAppUrl),
            state,
            authorizeUrl: config.slack.authorizeUrl,
          });
        },
        { requireWorkspace: "admin" },
      )

      // ── integrations list / disconnect ────────────────────────────────────
      .get(
        "/workspaces/:workspaceId/integrations",
        async ({ workspace }): Promise<ListIntegrationsResponse> => {
          const rows = await listIntegrations(db, workspace.organizationId);
          return { integrations: rows.map(integrationDto) };
        },
        { requireWorkspace: true },
      )
      .delete(
        "/workspaces/:workspaceId/integrations/:id",
        async ({ workspace, params }) => {
          const row = await findIntegration(db, workspace.organizationId, params.id);
          if (!row) throw errors.integrationNotFound();
          await deleteIntegration(db, row.id);
          return { id: row.id, deleted: true as const };
        },
        { requireWorkspace: "admin" },
      )

      // ── trigger bindings ──────────────────────────────────────────────────
      .get(
        "/workspaces/:workspaceId/workflows/:wfId/triggers",
        async ({ workspace, params }): Promise<ListTriggerBindingsResponse> => {
          await loadWorkflowOwned(workspace.organizationId, params.wfId);
          const rows = await listTriggers(db, params.wfId);
          return { triggers: rows.map(triggerBindingDto) };
        },
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/workflows/:wfId/triggers/webhook-token",
        async ({ workspace, params, set }): Promise<CreateWebhookTokenResponse> => {
          return mintToken(workspace.organizationId, params.wfId, set);
        },
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/workflows/:wfId/triggers/:id/rotate-token",
        async ({ workspace, params, set }): Promise<CreateWebhookTokenResponse> => {
          return mintToken(workspace.organizationId, params.wfId, set);
        },
        { requireWorkspace: true },
      )
      .put(
        "/workspaces/:workspaceId/workflows/:wfId/triggers/slack",
        async ({ workspace, params, body }): Promise<GetTriggerBindingResponse> => {
          await loadWorkflowOwned(workspace.organizationId, params.wfId);
          const parsed = updateSlackTriggerBindingRequestSchema.safeParse(body);
          if (!parsed.success) throw errors.invalidBody(parsed.error.issues);
          const integration = await findIntegration(
            db,
            workspace.organizationId,
            parsed.data.integrationId,
          );
          if (!integration || integration.type !== "slack") {
            throw errors.integrationNotFound();
          }
          const trigger = await upsertTriggerType(db, params.wfId, "slack");
          const updated = await setSlackBinding(
            db,
            trigger.id,
            integration.id,
            parsed.data.binding,
          );
          return { trigger: triggerBindingDto(updated) };
        },
        { requireWorkspace: true },
      )
  );

  // ── mint (shared by mint + rotate) ──────────────────────────────────────────
  async function mintToken(
    organizationId: string,
    workflowId: string,
    set: { status?: number | string },
  ): Promise<CreateWebhookTokenResponse> {
    const workflow = await loadWorkflowOwned(organizationId, workflowId);
    const definition = parseWorkflowDraft(workflow.draft);
    if (
      !definition ||
      (definition.trigger.type !== "webhook" && definition.trigger.type !== "form")
    ) {
      throw errors.triggerTypeMismatch("webhook", definition?.trigger.type ?? "unknown");
    }
    const triggerType = definition.trigger.type;
    const formSchema =
      definition.trigger.type === "form" ? definition.trigger.fields : null;

    const token = generateIngressToken();
    const trigger = await upsertTriggerType(db, workflowId, triggerType);
    const updated = await setTriggerToken(db, trigger.id, {
      type: triggerType,
      tokenHash: hashIngressToken(token),
      tokenSuffix: tokenSuffix(token),
      formSchema: formSchema ?? null,
    });
    set.status = 201;
    return {
      triggerId: updated.id,
      token,
      tokenSuffix: tokenSuffix(token),
      ingressUrl: ingressUrlForToken(config.publicAppUrl, token),
      createdAt: updated.updatedAt.toISOString(),
    };
  }

  // ── Slack event routing (async, post-ack) ───────────────────────────────────
  async function routeSlackEvent(teamId: string, event: SlackInnerEvent): Promise<void> {
    const integration = await findSlackIntegrationByTeam(db, teamId);
    if (!integration) return; // no install for this team — nothing to route
    const mapped = slackEventToTriggerData(event);
    if (!mapped.ok) return; // bot echo / edit / empty — ignore

    const botToken = decryptSlackBotToken(integration.credentialsEncrypted, integration.externalId);
    const extraAgentEnv: Record<string, string> = { SLACK_BOT_TOKEN: botToken };
    if (config.slack && config.slack.apiBaseUrl !== "https://slack.com/api") {
      // Point the compiled agent's outbound Slack calls at the same (stub)
      // endpoint in non-production deployments.
      extraAgentEnv.SLACK_API_BASE_URL = config.slack.apiBaseUrl;
    }

    const triggers = await listSlackTriggersForIntegration(db, integration.id);
    for (const { trigger, workflow } of triggers) {
      const bindingResult = trigger.binding
        ? slackTriggerBindingSchema.safeParse(trigger.binding)
        : null;
      const binding: SlackTriggerBinding = bindingResult?.success
        ? bindingResult.data
        : { mentionOnly: true, includeDirectMessages: false };

      const threadKey = slackThreadKey(
        integration.id,
        mapped.value.replyTarget.channel,
        mapped.value.threadKey,
      );
      const existingSession = await findSlackThreadSession(
        db,
        workflow.organizationId,
        workflow.id,
        threadKey,
      );

      if (!existingSession && !shouldStartNewSlackSession(event, binding)) {
        continue; // new thread that this binding does not start on
      }
      if (!workflow.publishedVersionId) continue;

      // Continuation runs the SESSION's pinned version (immutable); a new
      // session runs the workflow's current published version.
      const versionId = existingSession
        ? existingSession.workflowVersionId
        : workflow.publishedVersionId;
      let ready: ReadyVersion;
      try {
        ready = await requireReadyVersion(runtime, versionId);
      } catch {
        continue; // version not ready — skip this workflow
      }

      const principal: TriggerPrincipal = {
        workspaceId: workflow.organizationId,
        source: `slack:${event.user ?? "unknown"}`,
      };
      const dispatchInput: DispatchTriggerInput = {
        organizationId: workflow.organizationId,
        workflowId: workflow.id,
        ready,
        origin: "slack",
        triggerType: "slack",
        principal,
        message: mapped.value.message,
        data: mapped.value.data,
        extraAgentEnv,
        ...(existingSession
          ? { existingSession }
          : { sessionPrincipalExtra: { slackThreadKey: threadKey } }),
      };
      log("info", "trigger.received", {
        source: "slack",
        workflowId: workflow.id,
        continued: existingSession != null,
      });
      try {
        const result = await dispatchTriggerRun(runtime, dispatchInput);
        log("info", "dispatch.delivered", {
          source: "slack",
          workflowId: workflow.id,
          runId: result.run.id,
          sessionId: result.session.id,
        });
      } catch (error) {
        if (isRuntimeApiError(error) && error.code === "session_busy") continue;
        log("error", "dispatch.failed", {
          source: "slack",
          workflowId: workflow.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function decryptSlackBotToken(credentialsEncrypted: string, teamId: string): string {
    const plaintext = decryptIntegrationCredentials(
      credentialsEncrypted,
      masterKey,
      "slack",
      teamId,
    );
    return (JSON.parse(plaintext) as SlackStoredCredentials).botToken;
  }
}

// ── ingress body → TriggerEvent slice ────────────────────────────────────────

/** Map a webhook/form ingress body to the model message + trigger data. */
export function mapIngressBody(
  triggerType: "webhook" | "form",
  body: unknown,
  ready: ReadyVersion,
): { message: string; data: Record<string, unknown> } {
  if (triggerType === "webhook") {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw errors.formValidationFailed("webhook body must be a JSON object");
    }
    const record = body as Record<string, unknown>;
    const message =
      typeof record.message === "string" && record.message.length > 0
        ? record.message
        : "Incoming webhook event.";
    return { message, data: record };
  }

  // form: validate against the PUBLISHED version's form schema (authoritative).
  const definition = ready.definition;
  if (definition.trigger.type !== "form") {
    throw errors.triggerTypeMismatch("form", definition.trigger.type);
  }
  const values = (body as { values?: unknown })?.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw errors.formValidationFailed("form body must be { values: { ... } }");
  }
  const mapped = formSubmissionToTriggerData(
    definition.trigger.fields,
    values as Record<string, unknown>,
  );
  if (!mapped.ok) throw errors.formValidationFailed(mapped.reason);
  return { message: mapped.value.message, data: mapped.value.data };
}
