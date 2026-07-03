/**
 * Worker-plane identity contract (docs/PLAN.md Phase 3; INITIAL-SPEC.md §11
 * "Worker-plane auth"). Per-worker mTLS/identity was DEFERRED from Phase 1 to
 * here — this module FIXES THE SHAPE both planes agree on. The crypto lands in
 * the pool/worker builders; only the wire shapes + pure claim checks live here.
 *
 * Why upgrade from the Phase-1 shared secret
 * ------------------------------------------
 * Phase 1 guards every `/internal/*` call (both directions) with ONE shared
 * `x-worker-secret`. That is a single bearer credential: any holder can
 * impersonate any worker AND the control plane, and dispatches carry the
 * agent's full secret env (provider key, derived JWT secret, decrypted MCP
 * tokens — runtime-worker-contract.md). Phase 3 needs per-worker attribution
 * and mutual auth so a leaked/compromised worker cannot be replayed against
 * other workers.
 *
 * Two supported modes (both sides negotiate at register)
 * ------------------------------------------------------
 * 1. `worker-token` — the control plane mints two short-lived HS256 tokens,
 *    each signed with a PER-WORKER secret derived from the bootstrap shared
 *    secret + worker id (so the worker, which knows both, can verify inbound
 *    dispatches without any PKI):
 *      - worker SESSION token  (aud "control-plane", sub <workerId>): minted in
 *        the register RESPONSE, presented by the worker via `x-worker-token` on
 *        every heartbeat/deregister. Renewed on each heartbeat response. Proves
 *        "I am the worker that registered as <id>" without resending the
 *        bootstrap secret each call, and makes every call attributable.
 *      - DISPATCH token (aud "worker:<workerId>", sub "control-plane"): minted
 *        per ensure-agent / proxy dispatch, presented via `x-dispatch-token`,
 *        verified by the worker. A dispatch token for worker A is rejected by
 *        worker B (audience is version/worker-bound), so a captured dispatch
 *        cannot be replayed at another worker.
 *    The initial `register` call still authenticates with the bootstrap
 *    `x-worker-secret` (no token exists yet) — it is the ONLY call that does.
 *
 * 2. `mtls` — both directions authenticate with TLS client certs. The worker
 *    registers its cert fingerprint (`certFingerprint`); the control plane pins
 *    it and checks the presented client cert on every heartbeat/deregister. The
 *    control plane's own cert is pinned by the worker out of band. No tokens.
 *
 * The SHARED VERIFY HELPER (design; crypto lands in the builders)
 * --------------------------------------------------------------
 * The builder-side verifier is:
 *   verifyWorkerToken(rawJwt, { workerSharedSecret, workerId, expectedAudience })
 *     1. secret = HMAC-SHA256(workerSharedSecret, secretLabel + workerId)  ← per-worker
 *        (secretLabel = WORKER_SESSION_TOKEN_LABEL for the session token,
 *         WORKER_DISPATCH_TOKEN_LABEL for the dispatch token)
 *     2. verify the HS256 signature with that secret (jose `jwtVerify`)
 *     3. hand the decoded claims to {@link verifyWorkerTokenClaims} below, which
 *        does the pure, crypto-free part (iss/aud/exp/nbf/iat with clock skew).
 * Step 1–2 are crypto and live where jose is available (both planes already
 * mint/verify HS256 via `apps/control-plane/src/runtime/jwt.ts`). Step 3 is the
 * portable, unit-testable core shipped here so both sides can never drift on
 * what a valid claim set is.
 */
import { z } from "zod";

// ── Header + issuer constants (both planes import these) ─────────────────────

/** Bootstrap shared secret header — the ONLY credential on the first register. */
export const WORKER_BOOTSTRAP_SECRET_HEADER = "x-worker-secret";
/** Worker → control-plane per-worker session token (heartbeat/deregister). */
export const WORKER_TOKEN_HEADER = "x-worker-token";
/** Control-plane → worker per-call dispatch token (ensure-agent / proxy). */
export const DISPATCH_TOKEN_HEADER = "x-dispatch-token";
/** Worker id echoed on every worker→control-plane call (routing + audit). */
export const WORKER_ID_HEADER = "x-worker-id";

/** `iss` on every worker-plane token — the control plane is the sole minter. */
export const WORKER_TOKEN_ISSUER = "invisible-string-control-plane";

/** `sub` on a dispatch token (control-plane → worker). */
export const WORKER_TOKEN_SUBJECT_CONTROL_PLANE = "control-plane";

/** HKDF/HMAC info label for the worker SESSION token's per-worker secret. */
export const WORKER_SESSION_TOKEN_LABEL = "worker-session:";
/** HKDF/HMAC info label for the DISPATCH token's per-worker secret. */
export const WORKER_DISPATCH_TOKEN_LABEL = "worker-dispatch:";

/** Default lifetimes — short, renewed on each heartbeat / minted per dispatch. */
export const WORKER_SESSION_TOKEN_TTL_SECONDS = 120;
export const DISPATCH_TOKEN_TTL_SECONDS = 60;
/** Accepted clock skew when checking exp/nbf/iat (pure claim check). */
export const WORKER_TOKEN_CLOCK_SKEW_SECONDS = 30;

// ── Auth mode + identity declaration (register body) ─────────────────────────

export const WORKER_AUTH_MODES = ["shared-secret", "worker-token", "mtls"] as const;
/** `shared-secret` = Phase-1 baseline (local dev/CI); the others are Phase-3. */
export const workerAuthModeSchema = z.enum(WORKER_AUTH_MODES);
export type WorkerAuthMode = z.infer<typeof workerAuthModeSchema>;

/** SHA-256 fingerprint of a DER cert, lowercase hex, no colons (64 chars). */
export const certFingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a 64-char lowercase hex sha256 fingerprint");

/**
 * The worker's identity offer at register. `shared-secret`/`worker-token`
 * carry no material (the bootstrap secret authenticates the register call and,
 * for `worker-token`, the control plane derives the per-worker secret from it).
 * `mtls` pins the worker's client-cert fingerprint.
 */
export const workerIdentityDeclarationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("shared-secret") }),
  z.object({ mode: z.literal("worker-token") }),
  z.object({ mode: z.literal("mtls"), certFingerprint: certFingerprintSchema }),
]);
export type WorkerIdentityDeclaration = z.infer<
  typeof workerIdentityDeclarationSchema
>;

// ── Capacity + register/heartbeat wire shapes ────────────────────────────────

/** Live capacity a worker reports on register + every heartbeat. */
export const workerCapacityReportSchema = z.object({
  maxAgents: z.number().int().nonnegative(),
  runningAgents: z.number().int().nonnegative(),
  activeRequests: z.number().int().nonnegative(),
  /**
   * Content hashes of the agents currently running on this worker. The
   * scheduler prefers a worker already warm on the target hash (no artifact
   * pull + agent boot) — see runtime/scheduler.ts. Optional so a Phase-1
   * worker that omits it still validates (it is simply never "warm").
   */
  runningHashes: z.array(z.string()).optional(),
});
export type WorkerCapacityReport = z.infer<typeof workerCapacityReportSchema>;

const workerHttpUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "url must be an http(s) URL" },
  );

/**
 * `POST /internal/workers/register` body. Superset of the Phase-1
 * `{id, url, capacity}` (apps/worker/src/registration.ts) with the identity
 * offer; the extra field is additive so a Phase-1 worker still validates when
 * `identity` defaults to `shared-secret`.
 */
export const workerRegisterRequestSchema = z.object({
  id: z.uuid(),
  url: workerHttpUrl,
  capacity: workerCapacityReportSchema,
  identity: workerIdentityDeclarationSchema.default({ mode: "shared-secret" }),
});
export type WorkerRegisterRequest = z.infer<typeof workerRegisterRequestSchema>;

/**
 * `POST /internal/workers/register` response. In `worker-token` mode the worker
 * KEEPS `workerToken` and presents it on subsequent calls; `dispatchToken` is a
 * warm-up dispatch credential the worker can pre-verify (subsequent dispatches
 * mint fresh ones per call). In `shared-secret`/`mtls` mode the token fields are
 * omitted.
 */
export const workerRegisterResponseSchema = z.object({
  ok: z.literal(true),
  workerId: z.uuid(),
  authMode: workerAuthModeSchema,
  /** Present iff authMode === "worker-token": the session token to re-present. */
  workerToken: z.string().min(1).optional(),
  workerTokenExpiresAt: isoOrUndefined(),
  /** Interval the control plane expects heartbeats at (ms). */
  heartbeatIntervalMs: z.number().int().positive(),
});
export type WorkerRegisterResponse = z.infer<
  typeof workerRegisterResponseSchema
>;

/** `POST /internal/workers/heartbeat` body. */
export const workerHeartbeatRequestSchema = z.object({
  id: z.uuid(),
  url: workerHttpUrl.optional(),
  capacity: workerCapacityReportSchema.optional(),
});
export type WorkerHeartbeatRequest = z.infer<
  typeof workerHeartbeatRequestSchema
>;

/** Heartbeat ack — optionally rotates the session token (worker-token mode). */
export const workerHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  /** A fresh session token when the control plane chose to rotate; else absent. */
  workerToken: z.string().min(1).optional(),
  workerTokenExpiresAt: isoOrUndefined(),
});
export type WorkerHeartbeatResponse = z.infer<
  typeof workerHeartbeatResponseSchema
>;

// ── Token claims + the pure verify core ──────────────────────────────────────

/**
 * Decoded claims of a worker-plane token (session OR dispatch). The signature
 * is verified by the builder-side crypto BEFORE these are checked; this schema
 * + {@link verifyWorkerTokenClaims} own the crypto-free validation.
 */
export const workerTokenClaimsSchema = z.object({
  iss: z.string().min(1),
  /** Session token: the worker id. Dispatch token: "control-plane". */
  sub: z.string().min(1),
  /** Session token: "control-plane". Dispatch token: "worker:<workerId>". */
  aud: z.string().min(1),
  /** Unix seconds. */
  iat: z.number().int().nonnegative().optional(),
  nbf: z.number().int().nonnegative().optional(),
  exp: z.number().int().nonnegative(),
  /** Optional unique id for replay tracking (dispatch tokens). */
  jti: z.string().min(1).optional(),
});
export type WorkerTokenClaims = z.infer<typeof workerTokenClaimsSchema>;

/** Audience of a worker SESSION token (worker → control plane). */
export function controlPlaneAudience(): string {
  return "control-plane";
}

/** Audience of a DISPATCH token targeting one worker (control plane → worker). */
export function workerDispatchAudience(workerId: string): string {
  return `worker:${workerId}`;
}

/** Per-worker signing-secret INFO label for the session token (crypto: builders). */
export function workerSessionSecretLabel(workerId: string): string {
  return `${WORKER_SESSION_TOKEN_LABEL}${workerId}`;
}

/** Per-worker signing-secret INFO label for the dispatch token (crypto: builders). */
export function workerDispatchSecretLabel(workerId: string): string {
  return `${WORKER_DISPATCH_TOKEN_LABEL}${workerId}`;
}

export type WorkerTokenClaimCheck =
  | { ok: true; claims: WorkerTokenClaims }
  | { ok: false; reason: string };

/**
 * The PORTABLE, crypto-free half of the shared verify helper. Call it with the
 * ALREADY-signature-verified, decoded claims (see the module doc comment) plus
 * the audience/issuer the caller expects. Checks issuer, audience, and the time
 * window (exp/nbf/iat) with {@link WORKER_TOKEN_CLOCK_SKEW_SECONDS} of skew.
 * Pure — `now` is injected for tests.
 */
export function verifyWorkerTokenClaims(
  rawClaims: unknown,
  options: {
    expectedAudience: string;
    expectedIssuer?: string;
    now?: Date;
    skewSeconds?: number;
  },
): WorkerTokenClaimCheck {
  const parsed = workerTokenClaimsSchema.safeParse(rawClaims);
  if (!parsed.success) {
    return { ok: false, reason: "malformed worker token claims" };
  }
  const claims = parsed.data;
  const expectedIssuer = options.expectedIssuer ?? WORKER_TOKEN_ISSUER;
  if (claims.iss !== expectedIssuer) {
    return { ok: false, reason: `issuer mismatch (want ${expectedIssuer})` };
  }
  if (claims.aud !== options.expectedAudience) {
    return {
      ok: false,
      reason: `audience mismatch (want ${options.expectedAudience})`,
    };
  }
  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const skew = options.skewSeconds ?? WORKER_TOKEN_CLOCK_SKEW_SECONDS;
  if (nowSeconds > claims.exp + skew) {
    return { ok: false, reason: "token expired" };
  }
  if (claims.nbf !== undefined && nowSeconds + skew < claims.nbf) {
    return { ok: false, reason: "token not yet valid" };
  }
  if (claims.iat !== undefined && nowSeconds + skew < claims.iat) {
    return { ok: false, reason: "token issued in the future" };
  }
  return { ok: true, claims };
}

/**
 * Normalize a cert fingerprint to the stored form: lowercase, colon-free hex.
 * Accepts the common OpenSSL `AA:BB:...` rendering. Throws on a non-sha256
 * value so mis-registration is caught at the boundary. Pure.
 */
export function normalizeCertFingerprint(fingerprint: string): string {
  const normalized = fingerprint.replace(/:/g, "").trim().toLowerCase();
  const result = certFingerprintSchema.safeParse(normalized);
  if (!result.success) {
    throw new Error("invalid sha256 cert fingerprint");
  }
  return result.data;
}

/** Constant-timeless equality is fine here — fingerprints are not secrets. */
export function certFingerprintsMatch(a: string, b: string): boolean {
  try {
    return normalizeCertFingerprint(a) === normalizeCertFingerprint(b);
  } catch {
    return false;
  }
}

// zod v4 helper: an optional ISO timestamp (kept lenient — DB serializer owns format).
function isoOrUndefined() {
  return z.string().min(1).optional();
}
