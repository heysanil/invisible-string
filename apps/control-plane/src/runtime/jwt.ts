/**
 * Platform JWT minting (HS256 via jose) — the dispatcher's credential for
 * every call onto a compiled agent's eve channel routes. Compiled channels
 * verify with eve's `verifyJwtHmac` against the same PLATFORM_JWT_SECRET the
 * supervisor injects (PLAN correction 7; proven in the Phase-0 spike).
 *
 * Tokens are minted PER CALL with a short expiry — never cached, never
 * persisted, never logged.
 */
import { SignJWT } from "jose";

export const PLATFORM_JWT_ISSUER = "invisible-string";
export const PLATFORM_JWT_AUDIENCE = "workflow-agent";
export const PLATFORM_JWT_DEFAULT_TTL_SECONDS = 120;

export interface MintPlatformJwtOptions {
  /** Principal marker, e.g. "control-plane" (default) or "dispatcher". */
  subject?: string;
  /** Token lifetime in seconds (default {@link PLATFORM_JWT_DEFAULT_TTL_SECONDS}). */
  ttlSeconds?: number;
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
    .setAudience(PLATFORM_JWT_AUDIENCE)
    .setSubject(options.subject ?? "control-plane")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(new TextEncoder().encode(secret));
}
