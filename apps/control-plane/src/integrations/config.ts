/**
 * Integrations configuration (Phase 3 triggers). Loaded from env alongside the
 * base + runtime config; the Slack app is OPTIONAL — when its vars are absent
 * the Slack endpoints answer 503 `integration_not_configured` while
 * webhook/form ingress and trigger-token minting still work.
 *
 * - PUBLIC_APP_URL       public origin used to build ingress URLs (`/t/:token`)
 *                        and the Slack OAuth redirect (falls back to
 *                        BETTER_AUTH_URL, then http://localhost:3000).
 * - SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET  the single
 *                        platform-level Slack app (spec §2 locked).
 * - SLACK_BOT_SCOPES     comma/space-separated OAuth bot scopes (has a default).
 * - SLACK_API_BASE_URL   Slack Web API base (tests point it at a stub).
 * - SLACK_AUTHORIZE_URL  Slack consent base (tests point it at a stub).
 */
export interface SlackAppConfig {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  scopes: string[];
  /** Slack Web API base (oauth.v2.access / chat.postMessage). */
  apiBaseUrl: string;
  /** Slack consent endpoint the install flow redirects to. */
  authorizeUrl: string;
}

export interface IntegrationsConfig {
  /** Public origin for ingress URLs + OAuth redirect (no trailing slash). */
  publicAppUrl: string;
  /** Secret used to sign OAuth `state` (reuses the platform JWT secret). */
  stateSecret: string;
  /** Null when the Slack app is not configured on this deployment. */
  slack: SlackAppConfig | null;
}

/** Default Slack bot scopes: read mentions/DMs + reply. */
export const DEFAULT_SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "channels:history",
  "groups:history",
];

type Env = Record<string, string | undefined>;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadIntegrationsConfig(
  env: Env,
  stateSecret: string,
): IntegrationsConfig {
  const publicAppUrl = trimTrailingSlash(
    env.PUBLIC_APP_URL?.trim() ||
      env.BETTER_AUTH_URL?.trim() ||
      "http://localhost:3000",
  );

  const clientId = env.SLACK_CLIENT_ID?.trim();
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim();

  let slack: SlackAppConfig | null = null;
  if (clientId && clientSecret && signingSecret) {
    const scopesRaw = env.SLACK_BOT_SCOPES?.trim();
    const scopes = scopesRaw
      ? scopesRaw.split(/[\s,]+/).filter((s) => s.length > 0)
      : DEFAULT_SLACK_BOT_SCOPES;
    slack = {
      clientId,
      clientSecret,
      signingSecret,
      scopes,
      apiBaseUrl: trimTrailingSlash(
        env.SLACK_API_BASE_URL?.trim() || "https://slack.com/api",
      ),
      authorizeUrl:
        env.SLACK_AUTHORIZE_URL?.trim() || "https://slack.com/oauth/v2/authorize",
    };
  }

  return { publicAppUrl, stateSecret, slack };
}

/** The OAuth redirect URI Slack calls back (must match the app config). */
export function slackRedirectUri(publicAppUrl: string): string {
  return `${publicAppUrl}/integrations/slack/callback`;
}

/** Fully-qualified `POST /t/:token` ingress URL for a minted token. */
export function ingressUrlForToken(publicAppUrl: string, token: string): string {
  return `${publicAppUrl}/t/${token}`;
}
