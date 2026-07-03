import { describe, expect, test } from "bun:test";
import { generateMasterKeyBase64 } from "@invisible-string/shared";

import { ConfigError, loadConfig } from "./config";

const validEnv = {
  DATABASE_URL: "postgres://dev:dev@localhost:5432/product",
  BETTER_AUTH_SECRET: "test-secret-0123456789-0123456789",
};

describe("loadConfig", () => {
  test("parses a minimal valid environment with defaults", () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3000);
    expect(config.databaseUrl).toBe(validEnv.DATABASE_URL);
    expect(config.betterAuthSecret).toBe("test-secret-0123456789-0123456789");
    expect(config.betterAuthUrl).toBe("http://localhost:3000");
    expect(config.corsOrigins).toEqual(["http://localhost:5173"]);
    expect(config.trustedOrigins).toEqual([]);
    expect(config.encryptionMasterKey).toBeUndefined();
    expect(config.requireEmailVerification).toBe(false);
  });

  test("parses AUTH_REQUIRE_EMAIL_VERIFICATION", () => {
    for (const [raw, expected] of [
      ["1", true],
      ["true", true],
      ["0", false],
      ["false", false],
    ] as const) {
      expect(
        loadConfig({ ...validEnv, AUTH_REQUIRE_EMAIL_VERIFICATION: raw })
          .requireEmailVerification,
      ).toBe(expected);
    }
    expect(() =>
      loadConfig({ ...validEnv, AUTH_REQUIRE_EMAIL_VERIFICATION: "maybe" }),
    ).toThrow(/AUTH_REQUIRE_EMAIL_VERIFICATION/);
  });

  test("honors explicit values", () => {
    const key = generateMasterKeyBase64();
    const config = loadConfig({
      ...validEnv,
      PORT: "8080",
      BETTER_AUTH_URL: "https://api.example.com",
      CORS_ORIGIN: "https://app.example.com, https://staging.example.com",
      TRUSTED_ORIGINS: "http://localhost:5556",
      ENCRYPTION_MASTER_KEY: key,
    });
    expect(config.port).toBe(8080);
    expect(config.betterAuthUrl).toBe("https://api.example.com");
    expect(config.corsOrigins).toEqual([
      "https://app.example.com",
      "https://staging.example.com",
    ]);
    expect(config.trustedOrigins).toEqual(["http://localhost:5556"]);
    expect(config.encryptionMasterKey?.length).toBe(32);
  });

  test("BETTER_AUTH_URL default follows a custom PORT", () => {
    expect(loadConfig({ ...validEnv, PORT: "4000" }).betterAuthUrl).toBe(
      "http://localhost:4000",
    );
  });

  test("rejects a short BETTER_AUTH_SECRET (offline-brute-forceable)", () => {
    expect(() =>
      loadConfig({ ...validEnv, BETTER_AUTH_SECRET: "short" }),
    ).toThrow(/at least 32 characters/);
  });

  test("fails fast when required vars are missing, listing every problem", () => {
    let error: ConfigError | undefined;
    try {
      loadConfig({});
    } catch (err) {
      error = err as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error!.problems).toHaveLength(2);
    expect(error!.message).toContain("DATABASE_URL is required");
    expect(error!.message).toContain("BETTER_AUTH_SECRET is required");
  });

  test.each(["0", "70000", "abc", "3.14"])(
    "rejects invalid PORT %j",
    (port) => {
      expect(() => loadConfig({ ...validEnv, PORT: port })).toThrow(
        /PORT must be an integer/,
      );
    },
  );

  test("rejects a non-postgres DATABASE_URL without echoing credentials", () => {
    let error: ConfigError | undefined;
    try {
      loadConfig({
        ...validEnv,
        DATABASE_URL: "mysql://root:supersecret@localhost/x",
      });
    } catch (err) {
      error = err as ConfigError;
    }
    expect(error!.message).toContain("postgres://");
    expect(error!.message).not.toContain("supersecret");
  });

  test("rejects malformed BETTER_AUTH_URL and CORS origins", () => {
    expect(() =>
      loadConfig({ ...validEnv, BETTER_AUTH_URL: "not a url" }),
    ).toThrow(/BETTER_AUTH_URL/);
    expect(() =>
      loadConfig({ ...validEnv, CORS_ORIGIN: "ftp://nope" }),
    ).toThrow(/CORS_ORIGIN/);
    expect(() =>
      loadConfig({ ...validEnv, TRUSTED_ORIGINS: "localhost:5556" }),
    ).toThrow(/TRUSTED_ORIGINS/);
  });

  test("rejects a malformed ENCRYPTION_MASTER_KEY with a readable error", () => {
    expect(() =>
      loadConfig({ ...validEnv, ENCRYPTION_MASTER_KEY: "too-short" }),
    ).toThrow(/ENCRYPTION_MASTER_KEY is invalid/);
  });
});
