import { describe, expect, test } from "bun:test";

import {
  WEBHOOK_TOKEN_PREFIX,
  generateIngressToken,
  hashIngressToken,
  timingSafeHexEqual,
  tokenSuffix,
} from "./tokens";

describe("ingress tokens", () => {
  test("minted tokens are prefixed, high-entropy, and unique", () => {
    const a = generateIngressToken();
    const b = generateIngressToken();
    expect(a.startsWith(WEBHOOK_TOKEN_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    // 32 bytes → 43 base64url chars, plus the "whk_" prefix.
    expect(a.length).toBeGreaterThanOrEqual(WEBHOOK_TOKEN_PREFIX.length + 43);
  });

  test("hash is a stable 64-char sha256 hex and never the plaintext", () => {
    const token = generateIngressToken();
    const hash = hashIngressToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashIngressToken(token)).toBe(hash); // deterministic
    expect(hashIngressToken(token + "x")).not.toBe(hash);
  });

  test("suffix is the last 4 chars (non-secret display hint)", () => {
    expect(tokenSuffix("whk_abcdef2345")).toBe("2345");
    expect(tokenSuffix(generateIngressToken())).toHaveLength(4);
  });

  test("timingSafeHexEqual compares digests, rejects mismatched length", () => {
    const h = hashIngressToken("x");
    expect(timingSafeHexEqual(h, h)).toBe(true);
    expect(timingSafeHexEqual(h, hashIngressToken("y"))).toBe(false);
    expect(timingSafeHexEqual(h, h.slice(0, -1))).toBe(false);
  });
});
