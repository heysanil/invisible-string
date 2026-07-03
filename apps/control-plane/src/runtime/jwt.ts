/**
 * Platform JWT minting (HS256 via jose) — the dispatcher's credential for
 * every call onto a compiled agent's eve channel routes. Compiled channels
 * verify with eve's `verifyJwtHmac` against the PLATFORM_JWT_SECRET the
 * supervisor injects (PLAN correction 7; proven in the Phase-0 spike).
 *
 * TENANT ISOLATION (security review): the signing secret and the audience
 * are both bound to the workflow VERSION —
 * - secret: HKDF-style derivation `derivePlatformJwtSecret(master, hash)`,
 *   injected per agent as PLATFORM_JWT_SECRET, so a leaked agent env cannot
 *   verify or mint tokens for any other version;
 * - audience: `workflow-agent:<hash>` (compiler bakes the same value into
 *   the generated verifier), so a minted token is rejected by every agent
 *   except the one version it was minted for.
 *
 * Tokens are minted PER CALL with a short expiry — never cached, never
 * persisted, never logged.
 */
import { createHmac } from "node:crypto";

import { SignJWT } from "jose";
import {
  PLATFORM_JWT_AUDIENCE,
  PLATFORM_JWT_ISSUER,
  platformJwtAudienceForHash,
} from "@invisible-string/compiler";

// Re-exported from the compiler (generated channels verify these exact
// values) so the minting and verifying sides can never drift.
export { PLATFORM_JWT_AUDIENCE, PLATFORM_JWT_ISSUER, platformJwtAudienceForHash };
export const PLATFORM_JWT_DEFAULT_TTL_SECONDS = 120;

/**
 * Per-version signing secret: HMAC-SHA256(masterSecret, "agent-jwt:<hash>")
 * hex. Deterministic on both sides — the dispatcher derives it when minting
 * AND injects the same value as the agent's PLATFORM_JWT_SECRET, so no agent
 * ever holds the platform-wide master secret.
 */
export function derivePlatformJwtSecret(
  masterSecret: string,
  versionHash: string,
): string {
  return createHmac("sha256", masterSecret)
    .update(`agent-jwt:${versionHash}`)
    .digest("hex");
}

export interface MintPlatformJwtOptions {
  /** Principal marker, e.g. "control-plane" (default) or "dispatcher". */
  subject?: string;
  /** Token lifetime in seconds (default {@link PLATFORM_JWT_DEFAULT_TTL_SECONDS}). */
  ttlSeconds?: number;
  /**
   * Audience claim. Dispatch paths MUST pass the version-bound audience
   * ({@link platformJwtAudienceForHash}); the bare constant remains only for
   * non-agent uses/tests.
   */
  audience?: string;
  /** Extra public claims (e.g. { runId }) — for observability only. */
  claims?: Record<string, unknown>;
}

export async function mintPlatformJwt(
  secret: string,
  options: MintPlatformJwtOptions = {},
): Promise<string> {
  const ttl = options.ttlSeconds ?? PLATFORM_JWT_DEFAULT_TTL_SECONDS;
  return new SignJWT({ ...options.claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(PLATFORM_JWT_ISSUER)
    .setAudience(options.audience ?? PLATFORM_JWT_AUDIENCE)
    .setSubject(options.subject ?? "control-plane")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(new TextEncoder().encode(secret));
}

/** The (secret, audience) pair for dispatching onto one agent version. */
export function agentJwtParams(
  masterSecret: string,
  versionHash: string,
): { secret: string; audience: string } {
  return {
    secret: derivePlatformJwtSecret(masterSecret, versionHash),
    audience: platformJwtAudienceForHash(versionHash),
  };
}
