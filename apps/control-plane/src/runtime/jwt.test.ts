import { describe, expect, test } from "bun:test";
import { jwtVerify } from "jose";

import {
  mintPlatformJwt,
  PLATFORM_JWT_AUDIENCE,
  PLATFORM_JWT_DEFAULT_TTL_SECONDS,
  PLATFORM_JWT_ISSUER,
} from "./jwt";

const SECRET = "unit-test-platform-secret-000000";

describe("mintPlatformJwt", () => {
  test("verifies with the shared secret and carries the platform claims", async () => {
    const token = await mintPlatformJwt(SECRET);
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(SECRET),
      { issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE },
    );
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.sub).toBe("control-plane");
    expect(payload.iat).toBeNumber();
    expect(payload.exp).toBeNumber();
  });

  test("expiry is short: iat + default TTL", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await mintPlatformJwt(SECRET);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET));
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(
      PLATFORM_JWT_DEFAULT_TTL_SECONDS + 1,
    );
    expect(payload.exp!).toBeGreaterThanOrEqual(before + 30);
  });

  test("custom subject, ttl and claims", async () => {
    const token = await mintPlatformJwt(SECRET, {
      subject: "dispatcher",
      ttlSeconds: 10,
      claims: { runId: "r-1" },
    });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET));
    expect(payload.sub).toBe("dispatcher");
    expect(payload.runId).toBe("r-1");
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(11);
  });

  test("a wrong secret fails verification", async () => {
    const token = await mintPlatformJwt(SECRET);
    await expect(
      jwtVerify(token, new TextEncoder().encode("some-other-secret-0000000000")),
    ).rejects.toThrow();
  });
});
