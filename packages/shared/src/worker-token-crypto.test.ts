import { describe, expect, test } from "bun:test";

import {
  controlPlaneAudience,
  workerDispatchAudience,
  WORKER_SESSION_TOKEN_TTL_SECONDS,
  WORKER_TOKEN_ISSUER,
} from "./worker-identity";
import {
  derivePerWorkerSecret,
  mintDispatchToken,
  mintWorkerSessionToken,
  verifyDispatchToken,
  verifyWorkerSessionToken,
} from "./worker-token-crypto";

const SECRET = "bootstrap-worker-shared-secret-0123456789";
const WORKER_A = "6b4d8f6e-3a4e-4f6a-9a0e-2f6a1c9d8e7b";
const WORKER_B = "11112222-3333-4444-5555-666677778888";

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1]!;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("per-worker secret derivation", () => {
  test("session and dispatch secrets differ and are worker-bound", () => {
    const sessA = derivePerWorkerSecret(SECRET, WORKER_A, "session");
    const dispA = derivePerWorkerSecret(SECRET, WORKER_A, "dispatch");
    const sessB = derivePerWorkerSecret(SECRET, WORKER_B, "session");
    expect(sessA).not.toBe(dispA);
    expect(sessA).not.toBe(sessB);
    // Deterministic on both planes.
    expect(derivePerWorkerSecret(SECRET, WORKER_A, "session")).toBe(sessA);
  });
});

describe("worker session token — issue/verify/rotate", () => {
  test("mints a well-formed session token the control plane accepts", () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const { token, expiresAt } = mintWorkerSessionToken(SECRET, WORKER_A, { now });
    const claims = decodePayload(token);
    expect(claims.iss).toBe(WORKER_TOKEN_ISSUER);
    expect(claims.sub).toBe(WORKER_A);
    expect(claims.aud).toBe(controlPlaneAudience());
    expect(new Date(expiresAt).getTime()).toBe(
      now.getTime() + WORKER_SESSION_TOKEN_TTL_SECONDS * 1000,
    );

    const check = verifyWorkerSessionToken(SECRET, WORKER_A, token, now);
    expect(check.ok).toBe(true);
  });

  test("rotation yields a fresh, independently valid token", () => {
    const t1 = mintWorkerSessionToken(SECRET, WORKER_A, {
      now: new Date("2026-07-03T00:00:00Z"),
    }).token;
    const at = new Date("2026-07-03T00:01:00Z");
    const t2 = mintWorkerSessionToken(SECRET, WORKER_A, { now: at }).token;
    expect(t1).not.toBe(t2);
    expect(verifyWorkerSessionToken(SECRET, WORKER_A, t2, at).ok).toBe(true);
  });

  test("rejects a session token minted for a different worker id", () => {
    const token = mintWorkerSessionToken(SECRET, WORKER_A).token;
    // Verified against worker B's derived secret → signature mismatch.
    const check = verifyWorkerSessionToken(SECRET, WORKER_B, token);
    expect(check.ok).toBe(false);
  });

  test("rejects a tampered signature", () => {
    const token = mintWorkerSessionToken(SECRET, WORKER_A).token;
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(verifyWorkerSessionToken(SECRET, WORKER_A, tampered).ok).toBe(false);
  });

  test("rejects an expired session token (beyond skew)", () => {
    const issued = new Date("2026-07-03T00:00:00Z");
    const token = mintWorkerSessionToken(SECRET, WORKER_A, {
      now: issued,
      ttlSeconds: 120,
    }).token;
    const later = new Date(issued.getTime() + 200_000); // 200s > 120 + skew
    expect(verifyWorkerSessionToken(SECRET, WORKER_A, token, later).ok).toBe(false);
  });

  test("rejects a wrong bootstrap secret", () => {
    const token = mintWorkerSessionToken(SECRET, WORKER_A).token;
    expect(
      verifyWorkerSessionToken("some-other-bootstrap-secret-000000", WORKER_A, token).ok,
    ).toBe(false);
  });
});

describe("dispatch token — audience-bound to one worker", () => {
  test("mints a dispatch token the target worker accepts", () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const { token } = mintDispatchToken(SECRET, WORKER_A, { now });
    const claims = decodePayload(token);
    expect(claims.sub).toBe("control-plane");
    expect(claims.aud).toBe(workerDispatchAudience(WORKER_A));
    expect(claims.jti).toBeString();
    expect(verifyDispatchToken(SECRET, WORKER_A, token, now).ok).toBe(true);
  });

  test("worker B rejects a dispatch token minted for worker A (replay defence)", () => {
    const token = mintDispatchToken(SECRET, WORKER_A).token;
    expect(verifyDispatchToken(SECRET, WORKER_B, token).ok).toBe(false);
  });

  test("a session token is not accepted as a dispatch token (audience split)", () => {
    const sessionToken = mintWorkerSessionToken(SECRET, WORKER_A).token;
    expect(verifyDispatchToken(SECRET, WORKER_A, sessionToken).ok).toBe(false);
  });

  test("a dispatch token is not accepted as a session token", () => {
    const dispatchToken = mintDispatchToken(SECRET, WORKER_A).token;
    expect(verifyWorkerSessionToken(SECRET, WORKER_A, dispatchToken).ok).toBe(false);
  });
});
