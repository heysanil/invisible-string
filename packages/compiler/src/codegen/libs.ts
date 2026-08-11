/**
 * Generated `agent/lib/*` modules. Generated projects CANNOT depend on
 * workspace packages, so platform contracts (JWT claims) are inlined here as
 * standalone code; the source-of-truth shapes live in packages/shared and
 * the values below must stay in lockstep with the control-plane dispatcher
 * (compile-time constants, asserted by compiler tests).
 */
import {
  PLATFORM_API_URL_ENV,
  PLATFORM_JWT_ISSUER,
  platformJwtAudienceForHash,
} from "../platform";
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

/**
 * `agent/lib/platform-token.ts` — the broker-delivered OAuth path (connectors
 * redesign spec §6). Emitted only when the agent has an oauth connection.
 * The JWT is hand-rolled on node:crypto (generated projects take no runtime
 * deps beyond eve's own), and EVERY env read lives inside the call so the
 * keyless `eve build` never crashes.
 */
export function emitPlatformTokenLib(): string {
  return `import { createHmac } from "node:crypto";

import { requireEnv } from "./env.js";
import { PLATFORM_JWT_AUDIENCE, PLATFORM_JWT_ISSUER } from "./platform-auth.js";

/**
 * Broker-delivered OAuth access tokens: the platform's control plane holds
 * ALL OAuth material (refresh tokens never leave it); this agent only ever
 * sees short-lived access tokens fetched from
 * POST <${PLATFORM_API_URL_ENV}>/internal/connections/token, authenticated
 * with a self-minted platform JWT — HS256 under this version's
 * PLATFORM_JWT_SECRET with the version-bound audience baked into
 * platform-auth.ts, so the control plane serves ONLY this version's
 * connections. Env reads stay inside the call so keyless builds never crash.
 */

/** Lifetime of each self-minted JWT (seconds). */
const PLATFORM_JWT_TTL_SECONDS = 120;
/** Serve a cached access token only while it outlives this safety margin. */
const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** In-process cache per connection id — the broker refreshes centrally. */
const tokenCache = new Map<string, CachedToken>();

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Hand-rolled HS256 JWT on node:crypto — no runtime deps. */
function mintPlatformJwt(): string {
  const iat = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: PLATFORM_JWT_ISSUER,
      aud: PLATFORM_JWT_AUDIENCE,
      sub: "agent",
      iat,
      exp: iat + PLATFORM_JWT_TTL_SECONDS,
    }),
  );
  const signature = createHmac("sha256", requireEnv("PLATFORM_JWT_SECRET"))
    .update(\`\${header}.\${payload}\`)
    .digest("base64url");
  return \`\${header}.\${payload}.\${signature}\`;
}

/** The platform's typed error code when parseable, else the HTTP status. */
async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    if (typeof body.error?.code === "string") return body.error.code;
  } catch {
    // Non-JSON error body — fall through to the bare status.
  }
  return \`http_\${response.status}\`;
}

/**
 * A currently-valid access token for one platform-managed OAuth connection.
 * A non-200 answer THROWS (a failed tool call, never a hang) — the error
 * carries only the platform's error code, never token material.
 */
export async function platformConnectionToken(
  connectionId: string,
): Promise<string> {
  const cached = tokenCache.get(connectionId);
  if (cached !== undefined && cached.expiresAtMs - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  const response = await fetch(
    \`\${requireEnv(${tsString(PLATFORM_API_URL_ENV)})}/internal/connections/token\`,
    {
      method: "POST",
      headers: {
        authorization: \`Bearer \${mintPlatformJwt()}\`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ connectionId }),
    },
  );
  if (!response.ok) {
    throw new Error(
      \`connection needs re-authorization: \${await errorCode(response)}\`,
    );
  }
  const body = (await response.json()) as { token: string; expiresAt: string };
  const expiresAtMs = Date.parse(body.expiresAt);
  if (Number.isFinite(expiresAtMs)) {
    tokenCache.set(connectionId, { token: body.token, expiresAtMs });
  }
  return body.token;
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
