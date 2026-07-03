/**
 * Per-worker token crypto (docs/PLAN.md Phase 3 task 5; the deferred-from-
 * Phase-1 worker-plane identity). Implements the SIGN + VERIFY halves of the
 * shared verify helper described in `worker-identity.ts`, deliberately with
 * `node:crypto` HMAC-SHA256 rather than `jose` so BOTH planes can use it —
 * `apps/worker` has no `jose` dependency (it verifies inbound dispatch tokens),
 * while `apps/control-plane` mints them. Keeping one framework-free
 * implementation guarantees the two sides can never drift on the wire format.
 *
 * Token shape: a standard compact HS256 JWT (`header.payload.signature`,
 * base64url) whose per-worker signing secret is derived from the bootstrap
 * shared secret so no additional key material has to be distributed:
 *   secret = HMAC-SHA256(bootstrapSecret, "<label>:<workerId>")   (hex)
 * with distinct labels for the SESSION token (worker → control plane) and the
 * DISPATCH token (control plane → worker). A leaked session-token secret for
 * worker A therefore cannot forge dispatch tokens, nor tokens for worker B.
 *
 * The pure claim check (iss/aud/exp/nbf/iat with clock skew) lives in
 * `verifyWorkerTokenClaims` (worker-identity.ts); this module owns only the
 * signature + base64url handling and delegates claim validation to it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  controlPlaneAudience,
  verifyWorkerTokenClaims,
  workerDispatchAudience,
  workerDispatchSecretLabel,
  workerSessionSecretLabel,
  DISPATCH_TOKEN_TTL_SECONDS,
  WORKER_SESSION_TOKEN_TTL_SECONDS,
  WORKER_TOKEN_ISSUER,
  WORKER_TOKEN_SUBJECT_CONTROL_PLANE,
  type WorkerTokenClaimCheck,
} from "./worker-identity";

/** Which per-worker secret to derive — session (worker→CP) or dispatch (CP→worker). */
export type WorkerTokenKind = "session" | "dispatch";

/**
 * Derive the per-worker HS256 signing secret from the bootstrap shared secret.
 * Deterministic on both planes (the control plane mints, the worker verifies).
 */
export function derivePerWorkerSecret(
  bootstrapSecret: string,
  workerId: string,
  kind: WorkerTokenKind,
): string {
  const label =
    kind === "session"
      ? workerSessionSecretLabel(workerId)
      : workerDispatchSecretLabel(workerId);
  return createHmac("sha256", bootstrapSecret).update(label).digest("hex");
}

// ── base64url + compact-JWS helpers ──────────────────────────────────────────

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function encodeSegment(value: unknown): string {
  return base64url(JSON.stringify(value));
}

function signHs256(signingInput: string, secret: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

interface MintOptions {
  ttlSeconds?: number;
  now?: Date;
  /** Extra unique id for replay tracking (dispatch tokens set this by default). */
  jti?: string;
}

interface MintedToken {
  token: string;
  /** ISO timestamp of `exp` — handed back so the control plane can persist it. */
  expiresAt: string;
}

function mint(
  secret: string,
  claims: {
    sub: string;
    aud: string;
    ttlSeconds: number;
    jti?: string;
  },
  now: Date,
): MintedToken {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + claims.ttlSeconds;
  const payload: Record<string, unknown> = {
    iss: WORKER_TOKEN_ISSUER,
    sub: claims.sub,
    aud: claims.aud,
    iat,
    exp,
  };
  if (claims.jti !== undefined) payload.jti = claims.jti;
  const signingInput = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment(
    payload,
  )}`;
  const token = `${signingInput}.${signHs256(signingInput, secret)}`;
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

// ── minting (control plane) ──────────────────────────────────────────────────

/**
 * Mint the worker SESSION token returned in the register response and rotated
 * on each heartbeat. Signed with the per-worker SESSION secret; `sub` = worker
 * id, `aud` = "control-plane" so a captured dispatch token cannot be replayed
 * here (different audience) and vice versa.
 */
export function mintWorkerSessionToken(
  bootstrapSecret: string,
  workerId: string,
  options: MintOptions = {},
): MintedToken {
  return mint(
    derivePerWorkerSecret(bootstrapSecret, workerId, "session"),
    {
      sub: workerId,
      aud: controlPlaneAudience(),
      ttlSeconds: options.ttlSeconds ?? WORKER_SESSION_TOKEN_TTL_SECONDS,
      // Unique per mint so a rotation always yields a distinct token, even
      // when two mints land in the same clock second.
      jti: options.jti ?? cryptoRandomId(),
    },
    options.now ?? new Date(),
  );
}

/**
 * Mint a DISPATCH token targeting one worker (control plane → worker, per
 * ensure-agent / proxy dispatch). Signed with the per-worker DISPATCH secret;
 * `sub` = "control-plane", `aud` = "worker:<workerId>" so worker B rejects a
 * token minted for worker A.
 */
export function mintDispatchToken(
  bootstrapSecret: string,
  workerId: string,
  options: MintOptions = {},
): MintedToken {
  return mint(
    derivePerWorkerSecret(bootstrapSecret, workerId, "dispatch"),
    {
      sub: WORKER_TOKEN_SUBJECT_CONTROL_PLANE,
      aud: workerDispatchAudience(workerId),
      ttlSeconds: options.ttlSeconds ?? DISPATCH_TOKEN_TTL_SECONDS,
      jti: options.jti ?? cryptoRandomId(),
    },
    options.now ?? new Date(),
  );
}

// ── verifying (both planes) ──────────────────────────────────────────────────

function verify(
  secret: string,
  token: string,
  expectedAudience: string,
  now: Date | undefined,
): WorkerTokenClaimCheck {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed token (expected 3 segments)" };
  }
  const [header, payload, signature] = parts as [string, string, string];
  const expected = signHs256(`${header}.${payload}`, secret);
  // Constant-time signature comparison (both are base64url of the same length
  // on a match; length divergence short-circuits to a mismatch).
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed token payload" };
  }
  return verifyWorkerTokenClaims(claims, { expectedAudience, now });
}

/** Verify a worker SESSION token (control plane guarding heartbeat/deregister). */
export function verifyWorkerSessionToken(
  bootstrapSecret: string,
  workerId: string,
  token: string,
  now?: Date,
): WorkerTokenClaimCheck {
  const check = verify(
    derivePerWorkerSecret(bootstrapSecret, workerId, "session"),
    token,
    controlPlaneAudience(),
    now,
  );
  // A session token's `sub` must be the worker itself (defence in depth on top
  // of the per-worker secret + audience).
  if (check.ok && check.claims.sub !== workerId) {
    return { ok: false, reason: "session token subject is not this worker" };
  }
  return check;
}

/** Verify a DISPATCH token (worker guarding inbound ensure/proxy dispatch). */
export function verifyDispatchToken(
  bootstrapSecret: string,
  workerId: string,
  token: string,
  now?: Date,
): WorkerTokenClaimCheck {
  return verify(
    derivePerWorkerSecret(bootstrapSecret, workerId, "dispatch"),
    token,
    workerDispatchAudience(workerId),
    now,
  );
}

function cryptoRandomId(): string {
  // 16 random bytes, base64url — jti is a per-dispatch replay marker.
  return randomBytes(16).toString("base64url");
}
