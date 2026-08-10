/**
 * Platform-wide constants the compiler bakes into generated code AND the
 * control plane uses when minting dispatch JWTs. Values match the Phase-0
 * spike (spike/agent-project/agent/lib/platform-auth.ts + tests/harness.ts);
 * the dispatcher and the generated channels must agree on them.
 */
export const PLATFORM_JWT_ISSUER = "invisible-string";
export const PLATFORM_JWT_AUDIENCE = "agent-version";

/**
 * Env var carrying the control-plane base URL as reachable from the WORKER
 * network (prod compose: `http://control-plane:3000`). The emitted
 * `agent/lib/platform-token.ts` reads it to call
 * `POST /internal/connections/token`; the dispatcher's env assembly
 * (control-plane runtime/agent-env.ts) injects the same name — shared as a
 * constant so the two sides can never drift.
 */
export const PLATFORM_API_URL_ENV = "PLATFORM_API_URL";

/**
 * Version-bound JWT audience: every compiled agent verifies tokens against
 * `agent-version:<its own version hash>`, and the dispatcher mints with the
 * same value. A token minted for one agent version is therefore rejected by
 * every other agent — a leaked agent env cannot be used for cross-tenant
 * session access (security review: shared-JWT lateral movement).
 */
export function platformJwtAudienceForHash(versionHash: string): string {
  return `${PLATFORM_JWT_AUDIENCE}:${versionHash}`;
}
