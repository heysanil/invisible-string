import { describe, expect, test } from "bun:test";

import { compile } from "./compile";
import { canonicalJson, computeAgentHash } from "./hash";
import {
  anthropicModelFixture,
  basicFixture,
  customApprovalFixture,
  mcpSkillFixture,
} from "./test-fixtures";
import type { CompileDeps } from "./types";

describe("canonicalJson", () => {
  test("object key order never matters", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, null] } })).toBe(
      canonicalJson({ a: { c: [3, null], d: 2 }, b: 1 }),
    );
  });

  test("array order matters", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("undefined object values are dropped, like JSON", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  test("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 10n })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
});

describe("agent hash properties", () => {
  const { definition, deps } = mcpSkillFixture;

  test("is a sha256 hex string", () => {
    expect(computeAgentHash(definition, deps)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same input → same hash, same files (compile is deterministic)", () => {
    const first = compile(definition, deps);
    const second = compile(definition, deps);
    expect(first.hash).toBe(second.hash);
    expect([...first.files.keys()]).toEqual([...second.files.keys()]);
    for (const [path, content] of first.files) {
      expect(second.files.get(path)).toBe(content);
    }
  });

  test("input KEY ORDER never changes the hash", () => {
    const reordered = JSON.parse(JSON.stringify(definition)) as typeof definition;
    // Rebuild with reversed key insertion order at several depths.
    const shuffledDefinition = {
      context: { skillIds: reordered.context.skillIds, mcpConnectionIds: reordered.context.mcpConnectionIds },
      model: { reasoning: reordered.model.reasoning, preset: reordered.model.preset },
      persona: reordered.persona,
    } as typeof definition;
    expect(computeAgentHash(shuffledDefinition, deps)).toBe(
      computeAgentHash(definition, deps),
    );
  });

  test("resolved connection ARRAY ORDER never changes the hash", () => {
    const { definition: def, deps: multiDeps } = customApprovalFixture;
    const reversed: CompileDeps = {
      ...multiDeps,
      connections: [...multiDeps.connections].reverse(),
    };
    expect(computeAgentHash(def, reversed)).toBe(
      computeAgentHash(def, multiDeps),
    );
    expect(compile(def, reversed).hash).toBe(compile(def, multiDeps).hash);
  });

  test("changing the definition changes the hash", () => {
    const changed = {
      ...definition,
      persona: `${definition.persona} Tweaked.`,
    };
    expect(computeAgentHash(changed, deps)).not.toBe(
      computeAgentHash(definition, deps),
    );
  });

  test("agentSlug and workspaceSlug both change the hash (tenant isolation)", () => {
    expect(
      computeAgentHash(definition, { ...deps, agentSlug: "renamed-agent" }),
    ).not.toBe(computeAgentHash(definition, deps));
    // Identical agent configs in two workspaces must never share an
    // artifact, world database, or JWT audience.
    expect(
      computeAgentHash(definition, { ...deps, workspaceSlug: "other-tenant" }),
    ).not.toBe(computeAgentHash(definition, deps));
  });

  test("changing versions.json content changes the hash", () => {
    const bumped: CompileDeps = {
      ...deps,
      versions: { ...deps.versions, eve: "0.19.1" },
    };
    expect(computeAgentHash(definition, bumped)).not.toBe(
      computeAgentHash(definition, deps),
    );
    // Even a note-only change counts: the hash covers the CONTENT.
    const noted: CompileDeps = {
      ...deps,
      versions: { ...deps.versions, notes: ["changed"] },
    };
    expect(computeAgentHash(definition, noted)).not.toBe(
      computeAgentHash(definition, deps),
    );
  });

  test("changing COMPILER_VERSION changes the hash", () => {
    expect(computeAgentHash(definition, deps, "999.0.0")).not.toBe(
      computeAgentHash(definition, deps),
    );
  });

  test("buildEnvEpoch changes the hash; undefined keeps historical hashes (build-env changes must re-key cached artifacts)", () => {
    const epoch1: CompileDeps = { ...deps, buildEnvEpoch: 1 };
    const epoch2: CompileDeps = { ...deps, buildEnvEpoch: 2 };
    expect(computeAgentHash(definition, epoch1)).not.toBe(
      computeAgentHash(definition, deps),
    );
    expect(computeAgentHash(definition, epoch2)).not.toBe(
      computeAgentHash(definition, epoch1),
    );
    expect(computeAgentHash(definition, epoch1)).toBe(
      computeAgentHash(definition, { ...deps, buildEnvEpoch: 1 }),
    );
    expect(computeAgentHash(definition, { ...deps, buildEnvEpoch: undefined })).toBe(
      computeAgentHash(definition, deps),
    );
  });

  test("dev flag changes the hash (dev artifacts never cache-hit prod)", () => {
    const dev: CompileDeps = { ...deps, options: { dev: true } };
    expect(computeAgentHash(definition, dev)).not.toBe(
      computeAgentHash(definition, deps),
    );
  });

  test("resolved skill content changes the hash (stale-cache guard)", () => {
    const editedSkill: CompileDeps = {
      ...deps,
      skills: deps.skills.map((skill) => ({
        ...skill,
        markdown: `${skill.markdown}\nEdited.`,
      })),
    };
    expect(computeAgentHash(definition, editedSkill)).not.toBe(
      computeAgentHash(definition, deps),
    );
  });

  test("provider flip changes the hash", () => {
    const flipped: CompileDeps = {
      ...basicFixture.deps,
      resolvedModel: { provider: "anthropic", modelId: "claude-opus-4-8" },
    };
    expect(
      computeAgentHash(basicFixture.definition, flipped),
    ).not.toBe(
      computeAgentHash(basicFixture.definition, basicFixture.deps),
    );
  });

  test("hash and baked audience agree across fixtures", () => {
    const { hash } = compile(anthropicModelFixture.definition, anthropicModelFixture.deps);
    expect(hash).toBe(
      computeAgentHash(anthropicModelFixture.definition, anthropicModelFixture.deps),
    );
  });
});
