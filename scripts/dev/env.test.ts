import { describe, expect, test } from "bun:test";

import {
  GENERATED_SECRET_KEYS,
  bootstrapEnvContent,
  emptySecretKeys,
  generateSecret,
  mergeEnv,
  parseEnv,
} from "./env";

describe("parseEnv", () => {
  test("parses KEY=VALUE lines, ignoring comments and blanks", () => {
    const env = parseEnv("# comment\n\nFOO=bar\nBAZ=qux\n");
    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("preserves '=' inside values", () => {
    expect(parseEnv("URL=postgres://dev:dev@localhost:5432/product?a=b")).toEqual({
      URL: "postgres://dev:dev@localhost:5432/product?a=b",
    });
  });

  test("strips one layer of matching quotes", () => {
    expect(parseEnv(`A="hello world"\nB='single'\nC="unbalanced'`)).toEqual({
      A: "hello world",
      B: "single",
      C: `"unbalanced'`,
    });
  });

  test("later duplicate keys win", () => {
    expect(parseEnv("K=first\nK=second")).toEqual({ K: "second" });
  });

  test("keeps empty values as empty strings", () => {
    expect(parseEnv("EMPTY=")).toEqual({ EMPTY: "" });
  });
});

describe("generateSecret", () => {
  test("returns base64 of 32 random bytes, unique per call", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

describe("bootstrapEnvContent", () => {
  const example = [
    "# header comment",
    "DATABASE_URL=postgres://dev:dev@localhost:5432/product",
    "ENCRYPTION_MASTER_KEY=",
    "PLATFORM_JWT_SECRET=",
    "BETTER_AUTH_SECRET=",
    "WORKER_SHARED_SECRET=",
    "OPENROUTER_API_KEY=",
    "",
  ].join("\n");

  test("fills exactly the four generated-secret keys, deterministically", () => {
    let n = 0;
    const { content, generated } = bootstrapEnvContent(example, "/repo", () => `secret${++n}`);
    expect(generated).toEqual([...GENERATED_SECRET_KEYS]);
    expect(content).toContain("ENCRYPTION_MASTER_KEY=secret1");
    expect(content).toContain("PLATFORM_JWT_SECRET=secret2");
    expect(content).toContain("BETTER_AUTH_SECRET=secret3");
    expect(content).toContain("WORKER_SHARED_SECRET=secret4");
    // untouched lines survive verbatim
    expect(content).toContain("DATABASE_URL=postgres://dev:dev@localhost:5432/product");
    expect(content).toContain("OPENROUTER_API_KEY=");
    expect(content).toContain("# header comment");
  });

  test("appends ARTIFACT_CACHE_DIR under the repo root", () => {
    const { content } = bootstrapEnvContent(example, "/repo", () => "s");
    expect(content).toContain("ARTIFACT_CACHE_DIR=/repo/.dev/agent-cache");
  });

  test("appends ALLOW_INSECURE_WORKER_TRANSPORT=1 for dev workers over http://localhost", () => {
    const { content } = bootstrapEnvContent(example, "/repo", () => "s");
    expect(content).toContain("ALLOW_INSECURE_WORKER_TRANSPORT=1");
  });

  test("leaves already-filled secrets alone and does not report them", () => {
    const prefilled = example.replace("ENCRYPTION_MASTER_KEY=", "ENCRYPTION_MASTER_KEY=existing");
    const { content, generated } = bootstrapEnvContent(prefilled, "/repo", () => "gen");
    expect(content).toContain("ENCRYPTION_MASTER_KEY=existing");
    expect(generated).toEqual(["PLATFORM_JWT_SECRET", "BETTER_AUTH_SECRET", "WORKER_SHARED_SECRET"]);
  });

  test("the real .env.example has all four secrets blank so bootstrap fills them", async () => {
    const real = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    const { generated } = bootstrapEnvContent(real, "/repo", () => "s");
    expect(generated).toEqual([...GENERATED_SECRET_KEYS]);
  });

  test("the real .env.example keeps ALLOW_INSECURE_WORKER_TRANSPORT commented out", async () => {
    const real = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    expect(real).not.toMatch(/^ALLOW_INSECURE_WORKER_TRANSPORT=/m);
  });
});

describe("emptySecretKeys", () => {
  test("reports generated-secret keys that are blank or absent", () => {
    expect(
      emptySecretKeys({
        ENCRYPTION_MASTER_KEY: "set",
        PLATFORM_JWT_SECRET: "  ",
        BETTER_AUTH_SECRET: "",
      }),
    ).toEqual(["PLATFORM_JWT_SECRET", "BETTER_AUTH_SECRET", "WORKER_SHARED_SECRET"]);
  });

  test("empty when all four are set", () => {
    expect(
      emptySecretKeys({
        ENCRYPTION_MASTER_KEY: "a",
        PLATFORM_JWT_SECRET: "b",
        BETTER_AUTH_SECRET: "c",
        WORKER_SHARED_SECRET: "d",
      }),
    ).toEqual([]);
  });
});

describe("mergeEnv", () => {
  test("drops empty dotenv values so they cannot clobber shell env", () => {
    const merged = mergeEnv({ OPENROUTER_API_KEY: "", FOO: "from-dotenv" }, { PATH: "/bin" });
    expect(merged).toEqual({ FOO: "from-dotenv", PATH: "/bin" });
  });

  test("shell env wins over dotenv (Bun/dotenv precedence)", () => {
    const merged = mergeEnv({ FOO: "dotenv" }, { FOO: "shell" });
    expect(merged.FOO).toBe("shell");
  });

  test("skips undefined processEnv entries", () => {
    const merged = mergeEnv({ A: "1" }, { B: undefined, C: "2" });
    expect(merged).toEqual({ A: "1", C: "2" });
  });
});
