import {
  extractBearerToken,
  verifyJwtHmac,
  type AuthFn,
} from "eve/channels/auth";

/**
 * Platform route auth: an HS256 JWT signed with this agent's
 * PLATFORM_JWT_SECRET (a per-version secret derived by the control plane),
 * minted by the control-plane dispatcher. The audience is bound to THIS
 * workflow version's hash, so tokens minted for other versions are rejected.
 * Claim constants mirror the platform contract (packages/shared).
 */
export const PLATFORM_JWT_ISSUER = "invisible-string";
export const PLATFORM_JWT_AUDIENCE = "workflow-agent:42250a29f1a600f8dbd418702e061cbfd4ac9c8144b2c5e4a0a6c19c9a97973f";

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
  return [platformJwt()];
}
