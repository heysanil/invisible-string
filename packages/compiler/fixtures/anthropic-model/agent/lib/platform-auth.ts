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
export const PLATFORM_JWT_AUDIENCE = "agent-version:6c587815d51374e96d0b7d4909b4f429c72a7e9f22df28d3b1f8362abbc1b15a";

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
