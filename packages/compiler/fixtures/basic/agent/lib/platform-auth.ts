import {
  extractBearerToken,
  verifyJwtHmac,
  type AuthFn,
} from "eve/channels/auth";

/**
 * Platform route auth: an HS256 JWT signed with this agent's
 * PLATFORM_JWT_SECRET (a per-version secret derived by the control plane),
 * minted by the control-plane dispatcher. The audience is bound to THIS
 * agent version's hash, so tokens minted for other versions are rejected.
 * Claim constants mirror the platform contract (packages/shared).
 */
export const PLATFORM_JWT_ISSUER = "invisible-string";
export const PLATFORM_JWT_AUDIENCE = "agent-version:9e99e3d75e6f37ea9ba09d1350dbeaff025bbe56d1bcab807e8f8254114d886d";

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
