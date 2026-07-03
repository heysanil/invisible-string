/**
 * Platform-wide constants the compiler bakes into generated code AND the
 * control plane uses when minting dispatch JWTs. Values match the Phase-0
 * spike (spike/agent-project/agent/lib/platform-auth.ts + tests/harness.ts);
 * the dispatcher and the generated channels must agree on them.
 */
export const PLATFORM_JWT_ISSUER = "invisible-string";
export const PLATFORM_JWT_AUDIENCE = "workflow-agent";

/**
 * Locked route convention for compiled trigger channels: custom channel
 * routes mount at the RAW authored path (spike/REPORT.md finding 7), so
 * trigger channels ride the worker proxy's forwarded `/eve/` prefix.
 */
export const PLATFORM_TRIGGER_ROUTE_PREFIX = "/eve/v1/platform/";

export function triggerRoutePath(triggerType: string): string {
  return `${PLATFORM_TRIGGER_ROUTE_PREFIX}${triggerType}`;
}
