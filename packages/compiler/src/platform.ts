/**
 * Platform-wide constants the compiler bakes into generated code AND the
 * control plane uses when minting dispatch JWTs. Values match the Phase-0
 * spike (spike/agent-project/agent/lib/platform-auth.ts + tests/harness.ts);
 * the dispatcher and the generated channels must agree on them.
 */
export const PLATFORM_JWT_ISSUER = "invisible-string";
export const PLATFORM_JWT_AUDIENCE = "workflow-agent";

/**
 * Version-bound JWT audience: every compiled agent verifies tokens against
 * `workflow-agent:<its own version hash>`, and the dispatcher mints with the
 * same value. A token minted for one workflow version is therefore rejected
 * by every other agent — a leaked agent env cannot be used for cross-tenant
 * session access (security review: shared-JWT lateral movement).
 */
export function platformJwtAudienceForHash(versionHash: string): string {
  return `${PLATFORM_JWT_AUDIENCE}:${versionHash}`;
}

/**
 * Locked route convention for compiled trigger channels: custom channel
 * routes mount at the RAW authored path (spike/REPORT.md finding 7), so
 * trigger channels ride the worker proxy's forwarded `/eve/` prefix.
 */
export const PLATFORM_TRIGGER_ROUTE_PREFIX = "/eve/v1/platform/";

export function triggerRoutePath(triggerType: string): string {
  return `${PLATFORM_TRIGGER_ROUTE_PREFIX}${triggerType}`;
}
