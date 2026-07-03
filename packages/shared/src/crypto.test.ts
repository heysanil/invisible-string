import { describe, expect, test } from "bun:test";

import {
  ENVELOPE_VERSION,
  EnvelopeError,
  decryptSecret,
  encryptSecret,
  generateMasterKeyBase64,
  masterKeysEqual,
  parseMasterKey,
  rotateEnvelope,
  type EncryptedEnvelope,
  type MasterKey,
} from "./crypto";

const key = (): MasterKey => parseMasterKey(generateMasterKeyBase64());

describe("parseMasterKey", () => {
  test("accepts a base64-encoded 32-byte key", () => {
    const k = parseMasterKey(generateMasterKeyBase64());
    expect(k.length).toBe(32);
  });

  test("accepts surrounding whitespace (env files add newlines)", () => {
    const b64 = generateMasterKeyBase64();
    expect(masterKeysEqual(parseMasterKey(`  ${b64}\n`), parseMasterKey(b64))).toBe(
      true,
    );
  });

  test.each(["", "   "])("rejects empty input %j", (input) => {
    expect(() => parseMasterKey(input)).toThrow(EnvelopeError);
  });

  test("rejects keys of the wrong length with a readable message", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    expect(() => parseMasterKey(short)).toThrow(/32 bytes.*got 16/);
    const long = Buffer.alloc(48, 7).toString("base64");
    expect(() => parseMasterKey(long)).toThrow(/32 bytes.*got 48/);
  });

  test("rejects non-base64 garbage", () => {
    expect(() => parseMasterKey("!!!not-base64!!!")).toThrow(EnvelopeError);
  });
});

describe("encryptSecret / decryptSecret", () => {
  test("round-trips ASCII, unicode, JSON, and empty strings", () => {
    const k = key();
    for (const plaintext of [
      "hello world",
      "",
      "秘密 🔐 ключ",
      JSON.stringify({ token: "xoxb-1234", nested: { a: [1, 2, 3] } }),
      "x".repeat(64 * 1024), // 64 KiB payload
    ]) {
      const env = encryptSecret(plaintext, k);
      expect(decryptSecret(env, k)).toBe(plaintext);
    }
  });

  test("produces the documented JSON-serializable shape {v, edk, iv, tag, ct}", () => {
    const k = key();
    const env = encryptSecret("secret", k);
    expect(Object.keys(env).sort()).toEqual(["ct", "edk", "iv", "tag", "v"]);
    expect(env.v).toBe(ENVELOPE_VERSION);
    // Survives JSON round-trip (this is how it is stored in Postgres).
    const revived = JSON.parse(JSON.stringify(env)) as EncryptedEnvelope;
    expect(decryptSecret(revived, k)).toBe("secret");
    // Binary fields have the expected decoded sizes.
    expect(Buffer.from(env.edk, "base64").length).toBe(12 + 32 + 16);
    expect(Buffer.from(env.iv, "base64").length).toBe(12);
    expect(Buffer.from(env.tag, "base64").length).toBe(16);
  });

  test("uses a fresh data key and IV per value (no field repeats)", () => {
    const k = key();
    const a = encryptSecret("same plaintext", k);
    const b = encryptSecret("same plaintext", k);
    expect(a.edk).not.toBe(b.edk);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(a.tag).not.toBe(b.tag);
  });

  test("ciphertext does not contain the plaintext", () => {
    const k = key();
    const env = encryptSecret("super-secret-token-value", k);
    expect(Buffer.from(env.ct, "base64").toString("utf8")).not.toContain(
      "super-secret-token-value",
    );
  });

  test("decryption fails with the wrong master key", () => {
    const env = encryptSecret("secret", key());
    expect(() => decryptSecret(env, key())).toThrow(
      /wrong master key|tampered/,
    );
  });

  test.each(["edk", "iv", "tag", "ct"] as const)(
    "detects tampering of %s",
    (field) => {
      const k = key();
      const env = encryptSecret("payload to protect", k);
      const bytes = Buffer.from(env[field], "base64");
      bytes[0]! ^= 0xff; // flip bits in the first byte
      const tampered: EncryptedEnvelope = {
        ...env,
        [field]: bytes.toString("base64"),
      };
      expect(() => decryptSecret(tampered, k)).toThrow(EnvelopeError);
    },
  );

  test("cross-envelope splicing is rejected (edk from one, ct from another)", () => {
    const k = key();
    const a = encryptSecret("aaaa", k);
    const b = encryptSecret("bbbb", k);
    const spliced: EncryptedEnvelope = { ...a, ct: b.ct, iv: b.iv };
    // b's payload was encrypted under b's data key; a's edk unwraps a's key.
    expect(() => decryptSecret(spliced, k)).toThrow(EnvelopeError);
  });

  test("rejects unsupported versions and malformed envelopes", () => {
    const k = key();
    const env = encryptSecret("secret", k);
    expect(() =>
      decryptSecret({ ...env, v: 2 as unknown as 1 }, k),
    ).toThrow(/unsupported envelope version/);
    expect(() => decryptSecret({ ...env, iv: "" }, k)).toThrow(EnvelopeError);
    expect(() =>
      decryptSecret({ ...env, edk: Buffer.alloc(10).toString("base64") }, k),
    ).toThrow(/edk must decode/);
    expect(() =>
      decryptSecret({ ...env, tag: Buffer.alloc(8).toString("base64") }, k),
    ).toThrow(/tag must decode/);
  });
});

describe("aadContext (per-row/tenant binding)", () => {
  const CTX_A = "ws-a:mcp_connections:auth_config_encrypted:row-1";
  const CTX_B = "ws-b:mcp_connections:auth_config_encrypted:row-2";

  test("round-trips with the same context", () => {
    const k = key();
    const env = encryptSecret("tenant secret", k, CTX_A);
    expect(decryptSecret(env, k, CTX_A)).toBe("tenant secret");
  });

  test("an envelope relocated to another row/tenant fails to decrypt", () => {
    const k = key();
    const env = encryptSecret("workspace A secret", k, CTX_A);
    // Confused-deputy scenario: the intact envelope tuple is presented under
    // workspace B's row context — must fail authentication, not leak A's value.
    expect(() => decryptSecret(env, k, CTX_B)).toThrow(EnvelopeError);
  });

  test("context-bound envelopes do not decrypt without the context (and vice versa)", () => {
    const k = key();
    const bound = encryptSecret("bound", k, CTX_A);
    expect(() => decryptSecret(bound, k)).toThrow(EnvelopeError);
    const unbound = encryptSecret("unbound", k);
    expect(() => decryptSecret(unbound, k, CTX_A)).toThrow(EnvelopeError);
  });

  test("rotation preserves the context binding", () => {
    const oldKey = key();
    const newKey = key();
    const env = encryptSecret("rotate me", oldKey, CTX_A);
    // Rotation must present the same context to unwrap/re-wrap the data key.
    expect(() => rotateEnvelope(env, oldKey, newKey)).toThrow(EnvelopeError);
    const rotated = rotateEnvelope(env, oldKey, newKey, CTX_A);
    expect(decryptSecret(rotated, newKey, CTX_A)).toBe("rotate me");
    expect(() => decryptSecret(rotated, newKey, CTX_B)).toThrow(EnvelopeError);
  });

  test("rejects an empty context string (likely an interpolation bug)", () => {
    const k = key();
    expect(() => encryptSecret("x", k, "")).toThrow(/non-empty/);
  });
});

describe("rotateEnvelope (master-key rotation)", () => {
  test("re-wraps the data key without touching the payload", () => {
    const oldKey = key();
    const newKey = key();
    const env = encryptSecret("rotate me", oldKey);

    const rotated = rotateEnvelope(env, oldKey, newKey);

    // Payload ciphertext untouched — O(1) rotation.
    expect(rotated.ct).toBe(env.ct);
    expect(rotated.iv).toBe(env.iv);
    expect(rotated.tag).toBe(env.tag);
    expect(rotated.edk).not.toBe(env.edk);

    // New key decrypts; old key no longer does.
    expect(decryptSecret(rotated, newKey)).toBe("rotate me");
    expect(() => decryptSecret(rotated, oldKey)).toThrow(EnvelopeError);
    // Original envelope still decrypts under the old key.
    expect(decryptSecret(env, oldKey)).toBe("rotate me");
  });

  test("fails when the old key is wrong", () => {
    const env = encryptSecret("x", key());
    expect(() => rotateEnvelope(env, key(), key())).toThrow(
      /wrong master key|tampered/,
    );
  });

  test("supports multiple sequential rotations", () => {
    const keys = [key(), key(), key(), key()];
    let env = encryptSecret("long-lived secret", keys[0]!);
    for (let i = 1; i < keys.length; i++) {
      env = rotateEnvelope(env, keys[i - 1]!, keys[i]!);
    }
    expect(decryptSecret(env, keys[keys.length - 1]!)).toBe(
      "long-lived secret",
    );
  });
});
