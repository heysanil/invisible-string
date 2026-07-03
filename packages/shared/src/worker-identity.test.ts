import { describe, expect, test } from "bun:test";

import {
  certFingerprintsMatch,
  controlPlaneAudience,
  normalizeCertFingerprint,
  verifyWorkerTokenClaims,
  workerDispatchAudience,
  workerDispatchSecretLabel,
  workerIdentityDeclarationSchema,
  workerRegisterRequestSchema,
  workerRegisterResponseSchema,
  workerSessionSecretLabel,
  workerTokenClaimsSchema,
  WORKER_TOKEN_ISSUER,
} from "./worker-identity";

const HASH = "a".repeat(64);
const WORKER_ID = "6b4d8f6e-3a4e-4f6a-9a0e-2f6a1c9d8e7b";

describe("worker identity declaration", () => {
  test("shared-secret and worker-token carry no material", () => {
    expect(
      workerIdentityDeclarationSchema.safeParse({ mode: "shared-secret" }).success,
    ).toBe(true);
    expect(
      workerIdentityDeclarationSchema.safeParse({ mode: "worker-token" }).success,
    ).toBe(true);
  });

  test("mtls requires a valid sha256 fingerprint", () => {
    expect(
      workerIdentityDeclarationSchema.safeParse({
        mode: "mtls",
        certFingerprint: HASH,
      }).success,
    ).toBe(true);
    expect(
      workerIdentityDeclarationSchema.safeParse({ mode: "mtls" }).success,
    ).toBe(false);
    expect(
      workerIdentityDeclarationSchema.safeParse({
        mode: "mtls",
        certFingerprint: "AB:CD",
      }).success,
    ).toBe(false);
  });
});

describe("register request/response", () => {
  test("identity defaults to shared-secret (Phase-1 worker still validates)", () => {
    const parsed = workerRegisterRequestSchema.parse({
      id: WORKER_ID,
      url: "https://worker-1.internal:8080",
      capacity: { maxAgents: 20, runningAgents: 3, activeRequests: 1 },
    });
    expect(parsed.identity).toEqual({ mode: "shared-secret" });
  });

  test("rejects a non-http(s) worker url", () => {
    expect(
      workerRegisterRequestSchema.safeParse({
        id: WORKER_ID,
        url: "ftp://worker",
        capacity: { maxAgents: 1, runningAgents: 0, activeRequests: 0 },
      }).success,
    ).toBe(false);
  });

  test("worker-token response carries a token + expiry", () => {
    const ok = workerRegisterResponseSchema.safeParse({
      ok: true,
      workerId: WORKER_ID,
      authMode: "worker-token",
      workerToken: "eyJ...",
      workerTokenExpiresAt: "2026-07-03T00:02:00.000Z",
      heartbeatIntervalMs: 10_000,
    });
    expect(ok.success).toBe(true);
  });
});

describe("secret labels + audiences (both planes must agree)", () => {
  test("session vs dispatch labels are distinct and worker-bound", () => {
    expect(workerSessionSecretLabel(WORKER_ID)).toBe(
      `worker-session:${WORKER_ID}`,
    );
    expect(workerDispatchSecretLabel(WORKER_ID)).toBe(
      `worker-dispatch:${WORKER_ID}`,
    );
    expect(workerSessionSecretLabel(WORKER_ID)).not.toBe(
      workerDispatchSecretLabel(WORKER_ID),
    );
  });

  test("dispatch audience binds a token to one worker", () => {
    expect(controlPlaneAudience()).toBe("control-plane");
    expect(workerDispatchAudience(WORKER_ID)).toBe(`worker:${WORKER_ID}`);
    expect(workerDispatchAudience("A")).not.toBe(workerDispatchAudience("B"));
  });
});

describe("verifyWorkerTokenClaims (pure crypto-free core)", () => {
  const now = new Date("2026-07-03T00:00:00.000Z");
  const nowSec = Math.floor(now.getTime() / 1000);

  function claims(overrides: Record<string, unknown> = {}) {
    return {
      iss: WORKER_TOKEN_ISSUER,
      sub: WORKER_ID,
      aud: controlPlaneAudience(),
      iat: nowSec,
      exp: nowSec + 120,
      ...overrides,
    };
  }

  test("accepts a well-formed, in-window session token", () => {
    const result = verifyWorkerTokenClaims(claims(), {
      expectedAudience: controlPlaneAudience(),
      now,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects issuer mismatch", () => {
    const result = verifyWorkerTokenClaims(claims({ iss: "someone-else" }), {
      expectedAudience: controlPlaneAudience(),
      now,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("issuer") });
  });

  test("rejects audience mismatch (dispatch token can't act as session token)", () => {
    const result = verifyWorkerTokenClaims(
      claims({ aud: workerDispatchAudience(WORKER_ID) }),
      { expectedAudience: controlPlaneAudience(), now },
    );
    expect(result.ok).toBe(false);
  });

  test("rejects an expired token (beyond skew)", () => {
    const result = verifyWorkerTokenClaims(claims({ exp: nowSec - 60 }), {
      expectedAudience: controlPlaneAudience(),
      now,
      skewSeconds: 30,
    });
    expect(result).toEqual({ ok: false, reason: "token expired" });
  });

  test("tolerates clock skew on a just-expired token", () => {
    const result = verifyWorkerTokenClaims(claims({ exp: nowSec - 10 }), {
      expectedAudience: controlPlaneAudience(),
      now,
      skewSeconds: 30,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a not-yet-valid token", () => {
    const result = verifyWorkerTokenClaims(claims({ nbf: nowSec + 300 }), {
      expectedAudience: controlPlaneAudience(),
      now,
    });
    expect(result).toEqual({ ok: false, reason: "token not yet valid" });
  });

  test("rejects malformed claims", () => {
    expect(
      verifyWorkerTokenClaims(
        { iss: WORKER_TOKEN_ISSUER },
        { expectedAudience: controlPlaneAudience(), now },
      ).ok,
    ).toBe(false);
  });

  test("claims schema requires exp", () => {
    expect(
      workerTokenClaimsSchema.safeParse({
        iss: WORKER_TOKEN_ISSUER,
        sub: WORKER_ID,
        aud: controlPlaneAudience(),
      }).success,
    ).toBe(false);
  });
});

describe("cert fingerprint normalization", () => {
  test("strips colons and lowercases", () => {
    // 32 hex byte-pairs joined by colons = a 64-char sha256 fingerprint.
    const colonized = new Array(32).fill("AB").join(":");
    expect(normalizeCertFingerprint(colonized)).toBe("ab".repeat(32));
  });

  test("throws on a non-sha256 value", () => {
    expect(() => normalizeCertFingerprint("nope")).toThrow();
  });

  test("match compares normalized forms", () => {
    expect(certFingerprintsMatch(HASH, HASH.toUpperCase())).toBe(true);
    expect(certFingerprintsMatch(HASH, "b".repeat(64))).toBe(false);
    expect(certFingerprintsMatch("bad", HASH)).toBe(false);
  });
});
