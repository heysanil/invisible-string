import {
  extractBearerToken,
  localDev,
  verifyJwtHmac,
  type AuthFn,
} from "eve/channels/auth";

export const PLATFORM_JWT_ISSUER = "invisible-string";
export const PLATFORM_JWT_AUDIENCE = "workflow-agent";

/**
 * Route auth for platform-dispatched traffic: an HS256 JWT signed with the
 * shared PLATFORM_JWT_SECRET (minted by the control-plane dispatcher).
 * Replaces eve's scaffolded vercelOidc()/placeholderAuth().
 */
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

/**
 * localDev(), but suppressible via SPIKE_DISABLE_LOCAL_DEV=1 so the spike can
 * prove the fail-closed 401 path on loopback requests. Production compiler
 * templates simply omit localDev() outside dev builds.
 */
export function localDevUnlessDisabled(): AuthFn<Request> {
  const inner = localDev();
  return async (request) => {
    if (process.env.SPIKE_DISABLE_LOCAL_DEV === "1") return null;
    return inner(request);
  };
}
