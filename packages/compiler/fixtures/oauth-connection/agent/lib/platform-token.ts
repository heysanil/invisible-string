import { createHmac } from "node:crypto";

import { requireEnv } from "./env.js";
import { PLATFORM_JWT_AUDIENCE, PLATFORM_JWT_ISSUER } from "./platform-auth.js";

/**
 * Broker-delivered OAuth access tokens: the platform's control plane holds
 * ALL OAuth material (refresh tokens never leave it); this agent only ever
 * sees short-lived access tokens fetched from
 * POST <PLATFORM_API_URL>/internal/connections/token, authenticated
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
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** The platform's typed error code when parseable, else the HTTP status. */
async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    if (typeof body.error?.code === "string") return body.error.code;
  } catch {
    // Non-JSON error body — fall through to the bare status.
  }
  return `http_${response.status}`;
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
    `${requireEnv("PLATFORM_API_URL")}/internal/connections/token`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${mintPlatformJwt()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ connectionId }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `connection needs re-authorization: ${await errorCode(response)}`,
    );
  }
  const body = (await response.json()) as { token: string; expiresAt: string };
  const expiresAtMs = Date.parse(body.expiresAt);
  if (Number.isFinite(expiresAtMs)) {
    tokenCache.set(connectionId, { token: body.token, expiresAtMs });
  }
  return body.token;
}
