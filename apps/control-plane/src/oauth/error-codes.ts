/**
 * The CLOSED vocabulary of OAuth error codes a third party may contribute to a
 * message this platform persists, returns in a DTO, or hands to an agent.
 *
 * WHY AN ALLOWLIST AND NOT A PATTERN. The token, exchange and registration
 * endpoints all answer failures with a provider-authored `error` string, and
 * every one of those requests CARRIES A CREDENTIAL — the refresh token, the
 * authorization code, or the client secret. A hostile (or repointed)
 * authorization server can therefore echo the secret it just received straight
 * back as its own `error` value. Interpolating that into an error message
 * publishes it: `probe/service.ts` classifies `oauth_exchange_failed` as safe
 * detail and persists it to `connections.last_error`, which `connectionDto`
 * returns to every workspace reader, and the agent-facing token route
 * serializes the same message.
 *
 * A character class cannot stop this. `[a-zA-Z0-9_-]` — the obvious "machine
 * code" shape, and the one this file's predecessors used — is EXACTLY the
 * base64url alphabet, so any opaque token short enough to fit the length cap
 * passes it unchanged. Only a closed set does: an attacker cannot choose a
 * value that is simultaneously a credential and a member of this vocabulary.
 *
 * Anything unrecognised collapses to `null`, and callers then say only which
 * hop failed and with what HTTP status — never what the provider wrote.
 */

/** RFC 6749 §5.2 (token endpoint) + §4.1.2.1 (authorization endpoint). */
const RFC6749 = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "unsupported_response_type",
  "server_error",
  "temporarily_unavailable",
] as const;

/** RFC 7591 §3.2.2 (dynamic client registration). */
const RFC7591 = [
  "invalid_redirect_uri",
  "invalid_client_metadata",
  "invalid_software_statement",
  "unapproved_software_statement",
] as const;

/** RFC 8628 (device grant) + RFC 6750/9449, seen on MCP authorization servers. */
const RFC8628_AND_BEARER = [
  "authorization_pending",
  "slow_down",
  "expired_token",
  "invalid_token",
  "insufficient_scope",
  "use_dpop_nonce",
  "invalid_dpop_proof",
] as const;

export const OAUTH_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  ...RFC6749,
  ...RFC7591,
  ...RFC8628_AND_BEARER,
]);

/**
 * Codes that mean the grant or its client identity is PERMANENTLY unusable, so
 * retrying spends nothing but the row lock. Re-consent is the only recovery,
 * and it regenerates exactly what these complain about — the grant, the client,
 * and the scope set.
 *
 * `invalid_request` is deliberately ABSENT. It indicts our own request rather
 * than the grant, and servers have been seen returning it transiently; treating
 * it as terminal would let one malformed-looking blip retire a live grant.
 */
export const TERMINAL_TOKEN_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

/**
 * Normalize a provider-supplied `error` to a member of the vocabulary, or
 * `null` when it is anything else. Case and surrounding space are forgiven
 * (servers are inconsistent); the VALUE is not.
 */
export function providerErrorCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return OAUTH_PROVIDER_ERROR_CODES.has(normalized) ? normalized : null;
}

/** True when `raw` names a permanently-unusable grant (see above). */
export function isTerminalTokenError(raw: unknown): boolean {
  const code = providerErrorCode(raw);
  return code !== null && TERMINAL_TOKEN_ERROR_CODES.has(code);
}

/**
 * The one place a provider failure becomes a message. `detail` is the HTTP
 * status plus, ONLY when it is a recognised code, the code itself.
 */
export function describeProviderFailure(status: number, raw: unknown): string {
  const code = providerErrorCode(raw);
  return code === null ? `HTTP ${status}` : `HTTP ${status}: ${code}`;
}
