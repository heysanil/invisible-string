/**
 * Generated `agent/lib/*` modules. Generated projects CANNOT depend on
 * workspace packages, so platform contracts (JWT claims) are inlined here as
 * standalone code; the source-of-truth shapes live in packages/shared and
 * the values below must stay in lockstep with the control-plane dispatcher
 * (compile-time constants, asserted by compiler tests).
 */
import { PLATFORM_JWT_ISSUER, platformJwtAudienceForHash } from "../platform";
import { tsString } from "./strings";

export function emitPlatformAuthLib(dev: boolean, versionHash: string): string {
  const localDevImport = dev ? "\n  localDev," : "";
  const chain = dev ? "[platformJwt(), localDev()]" : "[platformJwt()]";
  const devNote = dev
    ? `\n * DEV BUILD: localDev() admits loopback traffic so local tooling can
 * reach the agent. Production artifacts omit it (spike/REPORT.md finding 16).`
    : "";
  return `import {
  extractBearerToken,${localDevImport}
  verifyJwtHmac,
  type AuthFn,
} from "eve/channels/auth";

/**
 * Platform route auth: an HS256 JWT signed with this agent's
 * PLATFORM_JWT_SECRET (a per-version secret derived by the control plane),
 * minted by the control-plane dispatcher. The audience is bound to THIS
 * agent version's hash, so tokens minted for other versions are rejected.
 * Claim constants mirror the platform contract (packages/shared).${devNote}
 */
export const PLATFORM_JWT_ISSUER = ${tsString(PLATFORM_JWT_ISSUER)};
export const PLATFORM_JWT_AUDIENCE = ${tsString(platformJwtAudienceForHash(versionHash))};

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
  return ${chain};
}
`;
}

export function emitEnvLib(): string {
  return `/** Read a REQUIRED env var (secrets are injected by the worker supervisor). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(\`Missing required environment variable \${name}\`);
  }
  return value;
}
`;
}
