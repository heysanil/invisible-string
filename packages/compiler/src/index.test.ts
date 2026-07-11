import { expect, test } from "bun:test";

import {
  COMPILER_VERSION,
  PLATFORM_JWT_AUDIENCE,
  PLATFORM_JWT_ISSUER,
  RUNTIME_VERSIONS,
  compile,
  connectionTokenEnvVar,
  platformJwtAudienceForHash,
} from "./index";
import { basicFixture } from "./test-fixtures";

test("public surface: compile + versions + platform constants", () => {
  expect(typeof compile).toBe("function");
  expect(COMPILER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  // versions.json is the ONLY source for runtime pins (Phase-0 spike matrix).
  expect(RUNTIME_VERSIONS.eve).toBe("0.19.0");
  expect(RUNTIME_VERSIONS.ai).toBe("7.0.14");
  expect(RUNTIME_VERSIONS.worldPostgres).toBe("5.0.0-beta.20");
  expect(RUNTIME_VERSIONS.openrouterProvider).toBe("6.0.0-alpha.1");
  expect(RUNTIME_VERSIONS.anthropicProvider).toBe("4.0.7");
  // Constants baked into the generated channel; the dispatcher must mint
  // matching claims (mirrors spike/agent-project/agent/lib/platform-auth.ts).
  expect(PLATFORM_JWT_ISSUER).toBe("invisible-string");
  expect(PLATFORM_JWT_AUDIENCE).toBe("agent-version");
  expect(platformJwtAudienceForHash("deadbeef")).toBe("agent-version:deadbeef");
  expect(connectionTokenEnvVar("my-conn")).toBe("MCP_MY_CONN_TOKEN");
});

test("generated projects never import workspace packages", () => {
  const { files } = compile(basicFixture.definition, basicFixture.deps);
  for (const [path, content] of files) {
    expect(content, path).not.toContain("@invisible-string/");
  }
});
