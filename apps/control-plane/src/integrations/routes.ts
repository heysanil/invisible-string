/**
 * Trigger ingress + integrations + trigger-binding HTTP surface. Mounted only
 * when the runtime is configured (dispatch needs workers + artifacts).
 *
 * Pipelines redesign: a trigger event on a workflow ALWAYS starts a PIPELINE
 * run (`startPipelineRun`) of the published snapshot — the control plane
 * interprets the steps itself; eve sessions exist only as `agent`-step CHILD
 * runs. A Slack event therefore always starts a NEW run: thread continuity is
 * the `agent` step's `session: "thread"`, keyed by the thread key this
 * ingress stamps into `TriggerEvent.data.slackThreadKey`. Nothing
 * trigger-specific reaches an agent, and no per-trigger env (the old
 * SLACK_BOT_TOKEN injection) exists; Slack replies are delivered by the
 * control-plane DeliveryService off the parent run's explicit
 * `onComplete.slackReply` (runs/delivery.ts).
 *
 * PUBLIC (token/signature authenticated, no session):
 * - POST /t/:token                    webhook + form ingress → dispatcher
 * - POST /integrations/slack/events   Slack Events API (verify → route → dispatch)
 * - GET  /integrations/slack/callback OAuth redirect-back (state-signed)
 * - GET  /integrations/mcp-oauth/client-metadata.json  CIMD client-id document
 *        (fetched by MCP authorization servers — must stay unauthenticated)
 * - GET  /integrations/mcp-oauth/callback  MCP OAuth consent redirect-back —
 *        public PATH, but SESSION-BOUND inside (the popup shares the app's
 *        cookies; oauth/broker.ts rejects callers who cannot manage the
 *        connection's scope before any state claim or token exchange)
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
import { z } from "zod";
import { schema } from "@invisible-string/db";
import {
  formFieldSchema,
  formSubmissionToTriggerData,
  slackEventToTriggerData,
  slackTriggerBindingSchema,
  slackWebhookBodySchema,
  updateSlackTriggerBindingRequestSchema,
  workflowConfigSchema,
  TRIGGER_INGRESS_MAX_BODY_BYTES,
  SLACK_REPLAY_WINDOW_SECONDS,
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  type CreateWebhookTokenResponse,
  type GetTriggerBindingResponse,
  type ListIntegrationsResponse,
  type ListTriggerBindingsResponse,
  type SlackInnerEvent,
  type SlackIntegrationMetadata,
  type SlackTriggerBinding,
  type TriggerEvent,
  type WorkflowConfig,
} from "@invisible-string/shared";

import { resolveWorkspace, workspacePlugin } from "../workspace";
import { errors, isRuntimeApiError } from "../runtime/errors";
import { startPipelineRun } from "../pipeline/runner";
import {
  isKnownSlackThread,
  PIPELINE_TRIGGER_AGENT_ID,
  resolveEnabledPipeline,
  slackThreadKey,
} from "../runtime/dispatch";
import { requirePipelines, type RuntimeDeps } from "../runtime/routes";
import {
  ingressUrlForToken,
  slackRedirectUri,
  type IntegrationsConfig,
} from "./config";
import {
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
import {
  buildSlackInstallUrl,
  signOAuthState,
  verifyOAuthStateDetailed,
  OAuthNonceCache,
} from "./slack-oauth";
import type { SlackClient } from "./slack-client";
import { SlackEventDedup, verifySlackRequest } from "./slack-verify";
import { hashIngressToken, generateIngressToken, tokenSuffix } from "./tokens";
import {
  handleCallback,
  renderCallbackPage,
  OAUTH_CALLBACK_CSP,
  type OauthBrokerDeps,
} from "../oauth/broker";
import { buildClientMetadataDocument } from "../oauth/client-identity";

type WorkflowRow = typeof schema.workflows.$inferSelect;

/**
 * Slack event payloads are small (a few KB); cap them far below the 8 MB
 * transport limit so an unauthenticated flooder cannot make us buffer + HMAC
 * megabytes per request. Shares the general trigger-ingress cap (256 KiB).
 */
export const SLACK_EVENT_MAX_BODY_BYTES = TRIGGER_INGRESS_MAX_BODY_BYTES;

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
  /** MCP OAuth consent broker (oauth/broker.ts) — the callback runs on it. */
  oauthBroker: OauthBrokerDeps;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Duck-typed Bun server (Elysia ctx.server) — only requestIP is consumed. */
interface SocketPeerSource {
  requestIP?(request: Request): { address?: string } | null;
}

/**
 * Client IP for rate limiting. X-Forwarded-For is attacker-writable, so it is
 * only consulted when `trustProxyHops > 0`, and then from the RIGHT: with N
 * trusted proxies the entry at `entries.length - N` is what the nearest
 * trusted proxy recorded. With no declared proxy the socket peer address is
 * authoritative and XFF is ignored entirely — a client cannot mint itself a
 * fresh rate-limit bucket per request by rotating a header.
 */
export function clientIpFrom(
  request: Request,
  trustProxyHops: number,
  server?: SocketPeerSource | null,
): string {
  if (trustProxyHops > 0) {
    const fwd = request.headers.get("x-forwarded-for");
    if (fwd) {
      const entries = fwd
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (entries.length > 0) {
        const idx = Math.max(0, entries.length - trustProxyHops);
        const candidate = entries[idx];
        if (candidate) return candidate;
      }
    }
  }
  const socket = server?.requestIP?.(request)?.address;
  return socket && socket.length > 0 ? socket : "unknown";
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

/**
 * PUBLIC: the CIMD client-metadata document (oauth/client-identity.ts).
 * For authorization servers that support client-ID-metadata-document clients
 * this document's URL IS our OAuth `client_id`, and the AS itself fetches it
 * during consent — so the route must stay unauthenticated and byte-stable for
 * a given base URL. Exported standalone so it is unit-testable without the
 * full integrations dependency graph.
 */
export function mcpOauthClientMetadataRoute(publicAppUrl: string) {
  return new Elysia({ name: "mcp-oauth-client-metadata" }).get(
    "/integrations/mcp-oauth/client-metadata.json",
    () => buildClientMetadataDocument(publicAppUrl),
  );
}

// ── plugin ───────────────────────────────────────────────────────────────────

export function integrationsPlugin(deps: IntegrationDeps) {
  const { runtime, config } = deps;
  const db = runtime.db;
  const masterKey = runtime.masterKey;
  // Structured, redaction-safe logging with correlation ids in the TOP-LEVEL
  // slots (never buried in `fields`), through the app logger so LOG_LEVEL
  // filtering and the mandatory redaction pass apply (observability contract).
  const logger = runtime.logger;
  const clientIp = (request: Request, server?: SocketPeerSource | null): string =>
    clientIpFrom(request, config.trustProxyHops, server);
  // Single-use OAuth install states (replay defense on top of the TTL).
  const oauthNonces = new OAuthNonceCache();

  // Webhook idempotency: a source-provided key (Idempotency-Key /
  // X-Idempotency-Key header) makes redelivery return the SAME run instead of
  // starting a duplicate. Bounded in-process cache (single control-plane node).
  // Pipeline runs have no session — the run id alone is the handle.
  const idempotency = new Map<string, { runId: string }>();
  const IDEMPOTENCY_MAX = 10_000;
  const rememberIdempotent = (key: string, value: { runId: string }) => {
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
      // ── PUBLIC: MCP OAuth client-identity metadata (CIMD) ─────────────────
      .use(mcpOauthClientMetadataRoute(config.publicAppUrl))
      .onError(({ error, set }) => {
        if (isRuntimeApiError(error)) {
          set.status = error.status;
          return error.toBody();
        }
        return undefined;
      })

      // ── PUBLIC path, SESSION-BOUND inside: MCP OAuth consent callback ─────
      //
      // The AS redirects the consent popup here; the popup shares the app's
      // cookies, so handleCallback authenticates the Better Auth session and
      // authorizes it against the connection's scope BEFORE claiming the
      // single-use state or exchanging the code (a forwarded callback URL is
      // useless to an outsider). Always renders the popup page — flow
      // failures come back as `ok:false` postMessages, never JSON errors.
      // The per-route CSP admits exactly this page's inline script; the
      // app-wide `default-src 'self'` would block it.
      .get(
        "/integrations/mcp-oauth/callback",
        async ({ query, request, set }) => {
          const outcome = await handleCallback(
            deps.oauthBroker,
            {
              ...(typeof query.code === "string" ? { code: query.code } : {}),
              ...(typeof query.state === "string" ? { state: query.state } : {}),
              ...(typeof query.error === "string" ? { error: query.error } : {}),
              // RFC 9207 — validated against the armed flow's expected issuer
              // before the code is exchanged (fix plan F13).
              ...(typeof query.iss === "string" ? { iss: query.iss } : {}),
            },
            request.headers,
          );
          set.headers["content-type"] = "text/html; charset=utf-8";
          set.headers["cache-control"] = "no-store";
          set.headers["content-security-policy"] = OAUTH_CALLBACK_CSP;
          // The postMessage target is the SPA's origin, NOT this server's
          // (fix plan F8): the popup's opener is the app, which in local dev
          // is a different origin, and a mismatched targetOrigin is dropped
          // by the browser in complete silence.
          return renderCallbackPage(outcome, deps.oauthBroker.publicWebUrl);
        },
      )

      // ── PUBLIC: webhook + form ingress ────────────────────────────────────
      //
      // 202 body is `{accepted: true, runId}` — pipeline runs have no session
      // — or `{accepted: false, reason: "overlap_skipped"}` when the
      // workflow's overlap policy dropped the event (a 2xx on purpose: the
      // event was consumed by policy, and a 4xx would make well-behaved
      // webhook sources retry a delivery the platform chose to skip).
      .post(
        "/t/:token",
        async ({ params, request, set, server }) => {
          const raw = await request.text();
          if (Buffer.byteLength(raw, "utf8") > TRIGGER_INGRESS_MAX_BODY_BYTES) {
            throw errors.triggerPayloadTooLarge(TRIGGER_INGRESS_MAX_BODY_BYTES);
          }
          const token = params.token;
          const ip = clientIp(request, server);
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
            logger.warn("trigger.rejected", {
              fields: { reason: "unknown_or_disabled_token" },
            });
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

          // Idempotency (webhook only): a source key maps redelivery to the
          // original run.
          const idemKey =
            request.headers.get("idempotency-key") ??
            request.headers.get("x-idempotency-key");
          if (idemKey) {
            const prior = idempotency.get(`${trigger.id}:${idemKey}`);
            if (prior) {
              set.status = 202;
              return { accepted: true, runId: prior.runId };
            }
          }

          // Kill switch + published pipeline snapshot.
          const config = resolveEnabledPipeline(workflow);

          // Form submissions validate against the trigger row's formSchema —
          // synced at workflow publish (and token rotation), so the persisted
          // row is authoritative for what this token accepts.
          const { message, data } = mapIngressBody(
            trigger.type,
            bodyJson,
            trigger.formSchema,
          );

          logger.info("trigger.received", {
            workspaceId: workflow.organizationId,
            workflowId: workflow.id,
            fields: { triggerType: trigger.type },
          });

          const triggerEvent: TriggerEvent = {
            // Pipelines bind no single agent — agents bind per step.
            agentId: PIPELINE_TRIGGER_AGENT_ID,
            workflowId: workflow.id,
            triggerType: trigger.type,
            message,
            data,
            principal: {
              workspaceId: workflow.organizationId,
              source: trigger.type,
            },
          };
          runtime.metrics.recordTrigger(trigger.type, "received");
          let result;
          try {
            result = await startPipelineRun(requirePipelines(runtime), {
              organizationId: workflow.organizationId,
              workflow: { id: workflow.id, config },
              triggerEvent,
              origin: trigger.type,
            });
          } catch (error) {
            runtime.metrics.recordTrigger(trigger.type, "failed");
            throw error;
          }
          if (!result.started) {
            logger.info("pipeline.overlap_skipped", {
              workspaceId: workflow.organizationId,
              workflowId: workflow.id,
              fields: { triggerType: trigger.type },
            });
            set.status = 202;
            return { accepted: false, reason: "overlap_skipped" };
          }
          runtime.metrics.recordTrigger(trigger.type, "dispatched");

          if (idemKey) {
            rememberIdempotent(`${trigger.id}:${idemKey}`, {
              runId: result.run.id,
            });
          }
          logger.info("dispatch.delivered", {
            workspaceId: workflow.organizationId,
            workflowId: workflow.id,
            runId: result.run.id,
          });

          set.status = 202;
          return { accepted: true, runId: result.run.id };
        },
        { parse: "none" },
      )

      // ── PUBLIC: Slack Events API ──────────────────────────────────────────
      .post(
        "/integrations/slack/events",
        async ({ request, set, server }) => {
          if (!config.slack) {
            throw errors.integrationNotConfigured("slack");
          }
          // Cheap gates FIRST (before buffering or HMAC-ing anything): missing
          // auth headers, per-IP budget, and a tight body cap — Slack event
          // payloads are small, so an 8 MB HMAC per anonymous request would be
          // free CPU burn for a flooder.
          const signature = request.headers.get(SLACK_SIGNATURE_HEADER);
          const timestamp = request.headers.get(SLACK_TIMESTAMP_HEADER);
          if (!signature || !timestamp) {
            set.status = 401;
            return { error: { code: "slack_signature_invalid", message: "signature verification failed" } };
          }
          const ip = clientIp(request, server);
          const ipDecision = deps.ipRateLimiter.hit(`slack:${ip}`);
          if (!ipDecision.allowed) {
            set.headers["retry-after"] = String(ipDecision.retryAfterSeconds);
            throw errors.rateLimited(ipDecision.retryAfterSeconds);
          }
          const raw = await request.text();
          if (Buffer.byteLength(raw, "utf8") > SLACK_EVENT_MAX_BODY_BYTES) {
            throw errors.triggerPayloadTooLarge(SLACK_EVENT_MAX_BODY_BYTES);
          }
          // Signature + replay window (before any parsing/routing).
          const verify = verifySlackRequest({
            signingSecret: config.slack.signingSecret,
            signature,
            timestamp,
            rawBody: raw,
            replayWindowSeconds: SLACK_REPLAY_WINDOW_SECONDS,
          });
          if (!verify.ok) {
            logger.warn("trigger.rejected", {
              fields: { source: "slack", reason: verify.reason },
            });
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
            logger.error("dispatch.failed", {
              err: error,
              fields: { source: "slack" },
            });
          });
          return { ok: true };
        },
        { parse: "none" },
      )

      // ── PUBLIC route, but SESSION-BOUND: Slack OAuth callback ─────────────
      //
      // The signed `state` alone must NOT decide which org owns the install —
      // an attacker who can mint a state for their own org could phish a
      // victim Slack admin into approving the consent link, landing the
      // victim's bot token under the attacker's org (tenant-binding CSRF).
      // The redirect back from Slack is a top-level GET to our origin, so the
      // initiating admin's session cookie rides along: the callback requires
      // a signed-in ADMIN of the state's workspace (same active workspace),
      // plus a single-use nonce so a captured state cannot be replayed.
      .get("/integrations/slack/callback", async ({ query, set, request }) => {
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
        const verified = verifyOAuthStateDetailed(config.stateSecret, state);
        if (!code || !verified) throw errors.slackStateInvalid();
        const workspaceId = verified.workspaceId;

        // Bind the round-trip to the initiating authenticated admin session.
        const resolution = await resolveWorkspace(
          runtime.workspaceDeps,
          request.headers,
          "admin",
          workspaceId,
        );
        if (!resolution.ok) {
          logger.warn("trigger.rejected", {
            workspaceId,
            fields: { source: "slack.install", reason: "no_admin_session_at_callback" },
          });
          redirectTo(`${settingsUrl}?slack=forbidden`);
          return;
        }

        // Single-use: a leaked/captured state is dead after its first use.
        if (!oauthNonces.consume(verified.nonce, verified.exp)) {
          throw errors.slackStateInvalid();
        }

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
        try {
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
        } catch (error) {
          if (isRuntimeApiError(error) && error.code === "slack_team_already_connected") {
            // Never silently steal a team another org already connected.
            redirectTo(`${settingsUrl}?slack=team_already_connected`);
            return;
          }
          throw error;
        }
        logger.info("trigger.received", {
          workspaceId,
          fields: { source: "slack.install" },
        });
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
    const parsed = workflowConfigSchema.safeParse(workflow.draft);
    const draft = parsed.success ? parsed.data : null;
    if (
      !draft ||
      (draft.trigger.type !== "webhook" && draft.trigger.type !== "form")
    ) {
      throw errors.triggerTypeMismatch("webhook", draft?.trigger.type ?? "unknown");
    }
    const triggerType = draft.trigger.type;
    const formSchema = draft.trigger.type === "form" ? draft.trigger.fields : null;

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

    // TWIN SUPPRESSION: one channel message that @mentions the bot arrives as
    // TWO events (`app_mention` AND `message.channels`) with DIFFERENT
    // event_ids, so event_id dedup cannot catch it. The app_mention twin is
    // authoritative (Slack pre-scopes it to our bot); drop the raw `message`
    // twin so a single user message never dispatches twice. Slack fires
    // app_mention for a mention ANYWHERE in the text (not just leading), so
    // the twin check must match mid-text mentions too — a leading-only check
    // lets "can <@bot> summarize this?" in an active thread dispatch twice
    // (both twins pass the busy-guard when they arrive seconds apart). DMs
    // are exempt — Slack sends no app_mention for IMs, the message.im IS the
    // event.
    const botUserId = (
      integration.metadata as Partial<SlackIntegrationMetadata> | null
    )?.botUserId;
    if (
      event.type === "message" &&
      event.channel_type !== "im" &&
      typeof botUserId === "string" &&
      botUserId.length > 0 &&
      (event.text ?? "").includes(`<@${botUserId}>`)
    ) {
      return;
    }

    const mapped = slackEventToTriggerData(event);
    if (!mapped.ok) return; // bot echo / edit / empty — ignore

    // NOTE (agents-first): no SLACK_BOT_TOKEN ever enters agent env — the
    // control-plane DeliveryService posts the reply off the parent pipeline
    // run's explicit `onComplete.slackReply` (runs/delivery.ts), so agent env
    // is identical across dispatch paths and warm processes can't hold a
    // stale token.
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
      // A Slack event ALWAYS starts a NEW pipeline run — but whether it
      // starts one at all keeps the old thread semantics: a reply in a
      // thread that already has a claimed session (an `agent` step's
      // `session: "thread"` child) dispatches REGARDLESS of the binding
      // (thread replies continue conversations); a fresh thread must pass
      // the binding gate. "Known" means ANY continuable session under the
      // bare key OR an agent-qualified derivative (`<bareKey>:agent:<id>`)
      // — once a bare holder terminates and releases its claim, a qualified
      // session may still carry the conversation, and a bare-key-only check
      // would silently drop every unmentioned reply in that thread. The
      // agent step, not this router, resolves the exact session and
      // continues the eve thread.
      const threadKnown = await isKnownSlackThread(
        db,
        workflow.organizationId,
        workflow.id,
        threadKey,
      );
      if (!threadKnown && !shouldStartNewSlackSession(event, binding)) {
        continue; // new thread that this binding does not start on
      }

      let config: WorkflowConfig;
      try {
        config = resolveEnabledPipeline(workflow);
      } catch {
        continue; // disabled / unpublished — skip this workflow
      }

      const triggerEvent: TriggerEvent = {
        // Pipelines bind no single agent — agents bind per step.
        agentId: PIPELINE_TRIGGER_AGENT_ID,
        workflowId: workflow.id,
        triggerType: "slack",
        message: mapped.value.message,
        // The thread key rides the envelope so the `agent` step
        // (`session: "thread"` continuity) and the DeliveryService
        // (`onComplete.slackReply` routing) can both resolve the thread
        // without re-deriving Slack routing from raw event fields.
        data: { ...mapped.value.data, slackThreadKey: threadKey },
        principal: {
          workspaceId: workflow.organizationId,
          source: `slack:${event.user ?? "unknown"}`,
        },
      };
      logger.info("trigger.received", {
        workspaceId: workflow.organizationId,
        workflowId: workflow.id,
        fields: { source: "slack", threadContinuation: threadKnown },
      });
      runtime.metrics.recordTrigger("slack", "received");
      try {
        const result = await startPipelineRun(requirePipelines(runtime), {
          organizationId: workflow.organizationId,
          workflow: { id: workflow.id, config },
          triggerEvent,
          origin: "slack",
        });
        if (!result.started) {
          // `overlap: "skip"`: a run of this workflow is still live. The
          // message is dropped BY POLICY (never silently — the thread's next
          // message dispatches once the run settles).
          logger.warn("pipeline.overlap_skipped", {
            workspaceId: workflow.organizationId,
            workflowId: workflow.id,
            fields: { source: "slack", dropped: true },
          });
          continue;
        }
        runtime.metrics.recordTrigger("slack", "dispatched");
        logger.info("dispatch.delivered", {
          workspaceId: workflow.organizationId,
          workflowId: workflow.id,
          runId: result.run.id,
          fields: { source: "slack" },
        });
      } catch (error) {
        runtime.metrics.recordTrigger("slack", "failed");
        // Session-plane conditions (session_busy, session_not_active) no
        // longer surface here: the eve dispatch happens inside the `agent`
        // step, which classifies and retries them (a dead thread session is
        // evicted there and the NEXT message mints a fresh one).
        logger.error("dispatch.failed", {
          workspaceId: workflow.organizationId,
          workflowId: workflow.id,
          err: error,
          fields: { source: "slack" },
        });
      }
    }
  }

}

// ── ingress body → TriggerEvent slice ────────────────────────────────────────

/**
 * Shape guard over the trigger row's persisted `form_schema` jsonb —
 * `{ fields: FormField[] }`, as written by `setTriggerToken` and
 * `syncTriggerForPublish` (integrations/service.ts).
 */
const persistedFormSchema = z.object({ fields: z.array(formFieldSchema).min(1) });

/**
 * Map a webhook/form ingress body to the model message + trigger data. Form
 * submissions validate against the TRIGGER ROW's `form_schema` (synced at
 * workflow publish / token rotation) — the persisted row is what this token
 * accepts, independent of later draft edits.
 */
export function mapIngressBody(
  triggerType: "webhook" | "form",
  body: unknown,
  formSchema: unknown,
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

  // form: the persisted field schema is authoritative.
  const parsed = persistedFormSchema.safeParse(formSchema);
  if (!parsed.success) {
    throw errors.formValidationFailed(
      "this trigger has no form schema — republish the workflow to sync it",
    );
  }
  const values = (body as { values?: unknown })?.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw errors.formValidationFailed("form body must be { values: { ... } }");
  }
  const mapped = formSubmissionToTriggerData(
    parsed.data.fields,
    values as Record<string, unknown>,
  );
  if (!mapped.ok) throw errors.formValidationFailed(mapped.reason);
  return { message: mapped.value.message, data: mapped.value.data };
}
