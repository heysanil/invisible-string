/**
 * Slack OAuth install helpers (docs/PLAN.md Phase 3 task 3.4): a single
 * platform-level Slack app (spec §2 locked). The install flow is:
 *
 *   GET /integrations/slack/install?workspaceId=… → 302 to Slack consent
 *     (state = signed { workspaceId, nonce, exp })
 *   ← Slack → GET /integrations/slack/callback?code=&state=
 *     (verify state → exchange code → store per-team creds encrypted)
 *
 * The `state` param is CSRF protection AND the carrier of the initiating
 * workspace id (Slack round-trips it verbatim). It is HMAC-signed + time-bound
 * so the callback trusts the workspace id without a server-side session store.
 * Pure + I/O-free (the code↔token exchange lives in slack-client.ts).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

interface StatePayload {
  workspaceId: string;
  nonce: string;
  /** Expiry, unix seconds. */
  exp: number;
}

/** Default install-state lifetime (10 min — plenty for a consent round-trip). */
export const SLACK_OAUTH_STATE_TTL_SECONDS = 600;

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64url");
}

/**
 * Produce a signed, time-bound `state` carrying the workspace id.
 * Format: `<base64url(json)>.<hmac>`.
 */
export function signOAuthState(
  secret: string,
  workspaceId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = SLACK_OAUTH_STATE_TTL_SECONDS,
): string {
  const payload: StatePayload = {
    workspaceId,
    nonce: randomBytes(12).toString("base64url"),
    exp: nowSeconds + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

/** A verified state's payload (workspace binding + single-use nonce). */
export interface VerifiedOAuthState {
  workspaceId: string;
  nonce: string;
  /** Expiry, unix seconds. */
  exp: number;
}

/**
 * Verify a `state` and return its full payload (or null when invalid/expired).
 * The nonce enables single-use enforcement — see {@link OAuthNonceCache}.
 */
export function verifyOAuthStateDetailed(
  secret: string,
  state: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifiedOAuthState | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = sign(secret, body);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return null;
  }
  if (
    typeof payload.workspaceId !== "string" ||
    payload.workspaceId.length === 0 ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length === 0 ||
    typeof payload.exp !== "number" ||
    payload.exp < nowSeconds
  ) {
    return null;
  }
  return { workspaceId: payload.workspaceId, nonce: payload.nonce, exp: payload.exp };
}

/** Verify a `state` and return its workspace id, or null when invalid/expired. */
export function verifyOAuthState(
  secret: string,
  state: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | null {
  return verifyOAuthStateDetailed(secret, state, nowSeconds)?.workspaceId ?? null;
}

/**
 * Single-use enforcement for OAuth state nonces: a signed state is otherwise
 * replayable for its whole TTL (only the Slack `code` is single-use).
 * `consume` returns true the FIRST time a nonce is presented and false on any
 * repeat; entries expire with the state's own `exp` so the cache stays small.
 * In-process — fine under the single-control-plane deployment constraint.
 */
export class OAuthNonceCache {
  private readonly consumed = new Map<string, number>();

  consume(nonce: string, expSeconds: number, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
    // Opportunistic prune of expired entries.
    for (const [key, exp] of this.consumed) {
      if (exp < nowSeconds) this.consumed.delete(key);
    }
    if (this.consumed.has(nonce)) return false;
    this.consumed.set(nonce, expSeconds);
    return true;
  }
}

export interface BuildInstallUrlInput {
  clientId: string;
  /** Bot scopes to request (space-joined into the `scope` param). */
  scopes: readonly string[];
  redirectUri: string;
  state: string;
  /** Slack authorize endpoint (default https://slack.com/oauth/v2/authorize). */
  authorizeUrl?: string;
}

const DEFAULT_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

/** Build the Slack consent URL to redirect the installer to. */
export function buildSlackInstallUrl(input: BuildInstallUrlInput): string {
  const url = new URL(input.authorizeUrl ?? DEFAULT_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", input.scopes.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}
