/**
 * Slack Web API client used by the control plane (docs/PLAN.md Phase 3
 * task 3.4). Two calls:
 *
 * - `exchangeOAuthCode` — POST oauth.v2.access (form-encoded) at install time;
 *   the trimmed result (validated by slackOAuthAccessResultSchema) splits into
 *   the encrypted bot token + non-secret team metadata.
 * - `postMessage` — chat.postMessage; the SAME protocol the compiled agent's
 *   agent/lib/slack.ts uses for outbound replies. Exposed here so the platform
 *   can post (e.g. an install confirmation) and so the shape is tested against
 *   a stub Slack server.
 *
 * `apiBaseUrl` is injectable so tests point it at a Bun.serve stub — there is
 * no real Slack in CI (spec §12 / task note). Never throws on a Slack-level
 * error; returns a typed result the caller maps.
 */
import {
  slackOAuthAccessResultSchema,
  type SlackOAuthAccessResult,
} from "@invisible-string/shared";

export const DEFAULT_SLACK_API_BASE_URL = "https://slack.com/api";

export interface SlackClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout (default 10s). */
  requestTimeoutMs?: number;
}

export interface ExchangeOAuthCodeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

export type ExchangeOAuthCodeResult =
  | { ok: true; value: SlackOAuthAccessResult }
  | { ok: false; error: string };

export interface PostMessageInput {
  token: string;
  channel: string;
  text: string;
  threadTs?: string;
}

export type PostMessageResult = { ok: true; ts?: string } | { ok: false; error: string };

export interface SlackClient {
  exchangeOAuthCode(input: ExchangeOAuthCodeInput): Promise<ExchangeOAuthCodeResult>;
  postMessage(input: PostMessageInput): Promise<PostMessageResult>;
}

export function createSlackClient(options: SlackClientOptions = {}): SlackClient {
  const base = (options.apiBaseUrl ?? DEFAULT_SLACK_API_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 10_000;

  return {
    async exchangeOAuthCode(input) {
      const body = new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      });
      let raw: unknown;
      try {
        const res = await doFetch(`${base}/oauth.v2.access`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
        raw = await res.json().catch(() => null);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      // Slack signals failure with { ok: false, error }.
      if (raw && typeof raw === "object" && (raw as { ok?: unknown }).ok === false) {
        const err = (raw as { error?: unknown }).error;
        return { ok: false, error: typeof err === "string" ? err : "oauth_error" };
      }
      const parsed = slackOAuthAccessResultSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: "unexpected oauth.v2.access response shape" };
      }
      return { ok: true, value: parsed.data };
    },

    async postMessage(input) {
      try {
        const res = await doFetch(`${base}/chat.postMessage`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${input.token}`,
          },
          body: JSON.stringify({
            channel: input.channel,
            text: input.text,
            ...(input.threadTs !== undefined ? { thread_ts: input.threadTs } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const result = (await res.json().catch(() => null)) as {
          ok?: boolean;
          ts?: string;
          error?: string;
        } | null;
        if (result === null || result.ok !== true) {
          return { ok: false, error: result?.error ?? `HTTP ${res.status}` };
        }
        return { ok: true, ts: result.ts };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
