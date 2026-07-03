/**
 * Generated `agent/lib/*` modules. Generated projects CANNOT depend on
 * workspace packages, so platform contracts (JWT claims, TriggerEvent) are
 * inlined here as standalone code; the source-of-truth shapes live in
 * packages/shared and the values below must stay in lockstep with the
 * control-plane dispatcher (compile-time constants, asserted by compiler
 * tests).
 */
import { PLATFORM_JWT_ISSUER, platformJwtAudienceForHash } from "../platform";
import { tsString } from "./strings";

export function emitPlatformAuthLib(dev: boolean, versionHash: string): string {
  const localDevImport = dev ? "\n  localDev," : "";
  const chain = dev ? "[platformJwt(), localDev()]" : "[platformJwt()]";
  const devNote = dev
    ? `\n * DEV BUILD: localDev() admits loopback traffic so local tooling can
 * reach the agent. Production artifacts omit it (spike/REPORT.md finding 16).`
    : "";
  return `import {
  extractBearerToken,${localDevImport}
  verifyJwtHmac,
  type AuthFn,
} from "eve/channels/auth";

/**
 * Platform route auth: an HS256 JWT signed with this agent's
 * PLATFORM_JWT_SECRET (a per-version secret derived by the control plane),
 * minted by the control-plane dispatcher. The audience is bound to THIS
 * workflow version's hash, so tokens minted for other versions are rejected.
 * Claim constants mirror the platform contract (packages/shared).${devNote}
 */
export const PLATFORM_JWT_ISSUER = ${tsString(PLATFORM_JWT_ISSUER)};
export const PLATFORM_JWT_AUDIENCE = ${tsString(platformJwtAudienceForHash(versionHash))};

export function platformJwt(): AuthFn<Request> {
  return async (request) => {
    const secret = process.env.PLATFORM_JWT_SECRET;
    if (secret === undefined || secret.length === 0) return null;
    const token = extractBearerToken(request.headers.get("authorization"));
    const result = await verifyJwtHmac(token, {
      algorithm: "HS256",
      audiences: [PLATFORM_JWT_AUDIENCE],
      issuer: PLATFORM_JWT_ISSUER,
      secret,
    });
    return result.ok ? result.sessionAuth : null;
  };
}

/** Ordered route-auth chain for every platform-facing channel route. */
export function platformAuth(): AuthFn<Request>[] {
  return ${chain};
}
`;
}

export function emitEnvLib(): string {
  return `/** Read a REQUIRED env var (secrets are injected by the worker supervisor). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(\`Missing required environment variable \${name}\`);
  }
  return value;
}
`;
}

/**
 * `agent/lib/slack.ts` — the Slack Web API outbound helper for the compiled
 * Slack trigger channel. Kept as a standalone, dependency-free module (no eve
 * imports) so it is unit-testable against a stub Slack server: the compiler
 * test in `slack-outbound.test.ts` imports the emitted file directly and
 * points `apiBaseUrl` at a Bun.serve stub.
 *
 * PLAN correction 3: eve's built-in Slack channel is Vercel-coupled, so the
 * platform posts replies via the Slack Web API with the team's bot token,
 * injected into the agent process env by the control-plane dispatcher
 * (`SLACK_BOT_TOKEN`) — never baked into generated code. `SLACK_API_BASE_URL`
 * lets tests redirect the endpoint; production defaults to slack.com.
 */
export function emitSlackLib(): string {
  return `/**
 * Slack Web API outbound helper (generated; inlined because generated projects
 * cannot depend on workspace packages). The compiled Slack trigger channel
 * calls postSlackReply() from its message.completed handler to post the
 * agent's terminal reply back to the originating thread.
 *
 * Credentials + endpoint come from the agent process env (injected by the
 * control-plane dispatcher / worker supervisor, never baked into code):
 * - SLACK_BOT_TOKEN     the team's bot token (xoxb-…)
 * - SLACK_API_BASE_URL  Slack Web API base (default https://slack.com/api;
 *                       tests point it at a stub server)
 */
export interface SlackReplyTarget {
  channel: string | null;
  threadTs: string | null;
}

/** Extract the reply channel + thread from an inbound Slack event's data. */
export function replyTargetFrom(data: Record<string, unknown>): SlackReplyTarget {
  const channel = typeof data.channel === "string" ? data.channel : null;
  const threadTs =
    typeof data.thread_ts === "string"
      ? data.thread_ts
      : typeof data.ts === "string"
        ? data.ts
        : null;
  return { channel, threadTs };
}

export interface PostSlackReplyOptions {
  /** Bot token; defaults to process.env.SLACK_BOT_TOKEN. */
  token?: string;
  /** Slack Web API base; defaults to SLACK_API_BASE_URL or slack.com. */
  apiBaseUrl?: string;
  /** Injected fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface PostSlackReplyResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_SLACK_API_BASE_URL = "https://slack.com/api";

/**
 * Post the reply text to target.channel (threaded when target.threadTs is set)
 * via chat.postMessage. Never throws — delivery failures are logged and
 * returned as { ok: false } so a failed reply cannot crash the agent turn.
 */
export async function postSlackReply(
  target: SlackReplyTarget,
  text: string,
  options: PostSlackReplyOptions = {},
): Promise<PostSlackReplyResult> {
  const token = options.token ?? process.env.SLACK_BOT_TOKEN;
  if (token === undefined || token.length === 0) {
    console.error("[slack] SLACK_BOT_TOKEN is not set; dropping outbound reply");
    return { ok: false, error: "missing_token" };
  }
  if (target.channel === null) {
    console.error("[slack] no reply channel recorded; dropping outbound reply");
    return { ok: false, error: "missing_channel" };
  }
  const base = (
    options.apiBaseUrl ??
    process.env.SLACK_API_BASE_URL ??
    DEFAULT_SLACK_API_BASE_URL
  ).replace(/\\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(base + "/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        channel: target.channel,
        text,
        ...(target.threadTs !== null ? { thread_ts: target.threadTs } : {}),
      }),
    });
    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (result === null || result.ok !== true) {
      const error = result?.error ?? "HTTP " + String(response.status);
      console.error("[slack] chat.postMessage failed: " + error);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (error) {
    console.error("[slack] chat.postMessage failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
`;
}

export function emitTriggerEventLib(): string {
  return `/**
 * TriggerEvent — the platform's normalized trigger envelope, inlined from
 * packages/shared/src/trigger-event.ts (generated projects cannot depend on
 * workspace packages). The control-plane dispatcher POSTs this shape to the
 * trigger channel with a platform JWT.
 */
export interface TriggerPrincipal {
  readonly workspaceId: string;
  readonly userId?: string;
  readonly source: string;
}

export interface TriggerFile {
  readonly name: string;
  readonly mediaType: string;
  /** Inline base64 (small payloads) or an object-store URL string. */
  readonly data: string;
}

export interface TriggerEvent {
  readonly workflowId: string;
  readonly triggerType: string;
  readonly message: string;
  /** Structured fields that {{trigger.*}} markers resolve against. */
  readonly data: Record<string, unknown>;
  readonly files?: readonly TriggerFile[];
  readonly principal: TriggerPrincipal;
  /** Maps threaded/conversational triggers onto an existing session. */
  readonly continuationToken?: string;
  /** Extra platform context blocks folded into the model message. */
  readonly context?: readonly string[];
}

export type ParseTriggerEventResult =
  | { readonly ok: true; readonly event: TriggerEvent }
  | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseTriggerEvent(body: unknown): ParseTriggerEventResult {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  if (typeof body.workflowId !== "string" || body.workflowId.length === 0) {
    return { ok: false, error: "workflowId (non-empty string) is required" };
  }
  if (typeof body.triggerType !== "string" || body.triggerType.length === 0) {
    return { ok: false, error: "triggerType (non-empty string) is required" };
  }
  if (typeof body.message !== "string") {
    return { ok: false, error: "message (string) is required" };
  }
  if (!isRecord(body.data)) {
    return { ok: false, error: "data (object) is required" };
  }
  const principal = body.principal;
  if (
    !isRecord(principal) ||
    typeof principal.workspaceId !== "string" ||
    principal.workspaceId.length === 0 ||
    typeof principal.source !== "string" ||
    principal.source.length === 0 ||
    (principal.userId !== undefined && typeof principal.userId !== "string")
  ) {
    return { ok: false, error: "principal { workspaceId, source, userId? } is required" };
  }
  if (
    body.continuationToken !== undefined &&
    (typeof body.continuationToken !== "string" || body.continuationToken.length === 0)
  ) {
    return { ok: false, error: "continuationToken must be a non-empty string" };
  }
  if (body.context !== undefined && !isStringArray(body.context)) {
    return { ok: false, error: "context must be an array of strings" };
  }
  if (body.files !== undefined) {
    if (
      !Array.isArray(body.files) ||
      !body.files.every(
        (file) =>
          isRecord(file) &&
          typeof file.name === "string" &&
          typeof file.mediaType === "string" &&
          typeof file.data === "string",
      )
    ) {
      return { ok: false, error: "files must be an array of { name, mediaType, data }" };
    }
  }
  return { ok: true, event: body as unknown as TriggerEvent };
}

/** Resolve a dot path (e.g. "customer.email") against TriggerEvent.data. */
export function resolveTriggerPath(
  data: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function formatTriggerValue(value: unknown): string {
  if (value === undefined) return "(not provided)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Fold platform context blocks + resolved {{trigger.*}} marker values into
 * the model message (custom channels fold context into the message; only the
 * default eve channel has an onMessage context hook).
 */
export function buildTriggerMessage(
  event: TriggerEvent,
  refPaths: readonly string[],
): string {
  const blocks: string[] = [...(event.context ?? [])];
  for (const path of refPaths) {
    const value = resolveTriggerPath(event.data, path);
    blocks.push(\`trigger.\${path}: \${formatTriggerValue(value)}\`);
  }
  if (blocks.length === 0) return event.message;
  return \`<trigger-context>\\n\${blocks.join("\\n")}\\n</trigger-context>\\n\\n\${event.message}\`;
}
`;
}
