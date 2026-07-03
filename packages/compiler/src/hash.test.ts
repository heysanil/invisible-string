import { describe, expect, test } from "bun:test";

import { compile } from "./compile";
import { canonicalJson, computeWorkflowHash } from "./hash";
import {
  formMcpSkillFixture,
  manualOnlyFixture,
  customApprovalFixture,
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

describe("workflow hash properties", () => {
  const { definition, deps } = formMcpSkillFixture;

  test("is a sha256 hex string", () => {
    expect(computeWorkflowHash(definition, deps)).toMatch(/^[0-9a-f]{64}$/);
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
      instructions: reordered.instructions,
      agent: { reasoning: reordered.agent.reasoning, agentPresetId: reordered.agent.agentPresetId },
      context: { skillIds: reordered.context.skillIds, mcpConnectionIds: reordered.context.mcpConnectionIds },
      trigger: reordered.trigger,
    } as typeof definition;
    expect(computeWorkflowHash(shuffledDefinition, deps)).toBe(
      computeWorkflowHash(definition, deps),
    );
  });

  test("resolved connection ARRAY ORDER never changes the hash", () => {
    const { definition: def, deps: multiDeps } = customApprovalFixture;
    const reversed: CompileDeps = {
      ...multiDeps,
      connections: [...multiDeps.connections].reverse(),
    };
    expect(computeWorkflowHash(def, reversed)).toBe(
      computeWorkflowHash(def, multiDeps),
    );
    expect(compile(def, reversed).hash).toBe(compile(def, multiDeps).hash);
  });

  test("changing the definition changes the hash", () => {
    const changed = {
      ...definition,
      instructions: { markdown: `${definition.instructions.markdown} Tweaked.` },
    };
    expect(computeWorkflowHash(changed, deps)).not.toBe(
      computeWorkflowHash(definition, deps),
    );
  });

  test("changing versions.json content changes the hash", () => {
    const bumped: CompileDeps = {
      ...deps,
      versions: { ...deps.versions, eve: "0.19.1" },
    };
    expect(computeWorkflowHash(definition, bumped)).not.toBe(
      computeWorkflowHash(definition, deps),
    );
    // Even a note-only change counts: the hash covers the CONTENT.
    const noted: CompileDeps = {
      ...deps,
      versions: { ...deps.versions, notes: ["changed"] },
    };
    expect(computeWorkflowHash(definition, noted)).not.toBe(
      computeWorkflowHash(definition, deps),
    );
  });

  test("changing COMPILER_VERSION changes the hash", () => {
    expect(computeWorkflowHash(definition, deps, "999.0.0")).not.toBe(
      computeWorkflowHash(definition, deps),
    );
  });

  test("dev flag changes the hash (dev artifacts never cache-hit prod)", () => {
    const dev: CompileDeps = { ...deps, options: { dev: true } };
    expect(computeWorkflowHash(definition, dev)).not.toBe(
      computeWorkflowHash(definition, deps),
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
    expect(computeWorkflowHash(definition, editedSkill)).not.toBe(
      computeWorkflowHash(definition, deps),
    );
  });

  test("provider flip changes the hash", () => {
    const flipped: CompileDeps = {
      ...manualOnlyFixture.deps,
      resolvedModel: { provider: "anthropic", modelId: "claude-opus-4-8" },
    };
    expect(
      computeWorkflowHash(manualOnlyFixture.definition, flipped),
    ).not.toBe(
      computeWorkflowHash(manualOnlyFixture.definition, manualOnlyFixture.deps),
    );
  });
});
