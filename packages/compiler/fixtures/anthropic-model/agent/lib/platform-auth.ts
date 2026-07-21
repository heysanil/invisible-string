import {
  extractBearerToken,
  localDev,
  verifyJwtHmac,
  type AuthFn,
} from "eve/channels/auth";

/**
 * Platform route auth: an HS256 JWT signed with this agent's
 * PLATFORM_JWT_SECRET (a per-version secret derived by the control plane),
 * minted by the control-plane dispatcher. The audience is bound to THIS
 * agent version's hash, so tokens minted for other versions are rejected.
 * Claim constants mirror the platform contract (packages/shared).
 * DEV BUILD: localDev() admits loopback traffic so local tooling can
 * reach the agent. Production artifacts omit it (spike/REPORT.md finding 16).
 */
export const PLATFORM_JWT_ISSUER = "invisible-string";
export const PLATFORM_JWT_AUDIENCE = "agent-version:9ca5c640ed13558566739b1c42c1e99476d89a2ca3007a4b5274e6e3ea58b7d2";

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
  return [platformJwt(), localDev()];
}
