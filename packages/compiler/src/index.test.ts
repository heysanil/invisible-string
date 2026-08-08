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
  // versions.json is the ONLY source for runtime pins. Matrix proven by the
  // spike suites, which are the upgrade gate for any eve bump (AGENTS.md).
  expect(RUNTIME_VERSIONS.eve).toBe("0.31.3");
  expect(RUNTIME_VERSIONS.ai).toBe("7.0.58");
  expect(RUNTIME_VERSIONS.worldPostgres).toBe("5.0.0-beta.32");
  expect(RUNTIME_VERSIONS.openrouterProvider).toBe("3.0.0");
  expect(RUNTIME_VERSIONS.anthropicProvider).toBe("4.0.36");
  expect(RUNTIME_VERSIONS.typescript).toBe("7.0.2");
  expect(RUNTIME_VERSIONS.node).toBe("24.19.0");
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
