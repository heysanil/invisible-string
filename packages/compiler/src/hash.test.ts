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

  test("agentId, agentSlug and workspaceSlug all change the hash", () => {
    // IDENTITY (spec D1): the agent's stable id keys the artifact.
    expect(
      computeAgentHash(definition, { ...deps, agentId: "a-different-agent" }),
    ).not.toBe(computeAgentHash(definition, deps));
    // agentSlug stays hashed because it shapes emitted BYTES (generated
    // package name, model-visible identity line) — a rename must not
    // cache-hit an artifact that introduces itself by the old name.
    expect(
      computeAgentHash(definition, { ...deps, agentSlug: "renamed-agent" }),
    ).not.toBe(computeAgentHash(definition, deps));
    // Identical agent configs in two workspaces must never share an
    // artifact, world database, or JWT audience.
    expect(
      computeAgentHash(definition, { ...deps, workspaceSlug: "other-tenant" }),
    ).not.toBe(computeAgentHash(definition, deps));
  });

  test("two agents with IDENTICAL definitions AND identical names hash differently", () => {
    // The collision spec D1 exists to close. Before the agent id entered the
    // hash, these two rows produced one content hash — hence one artifact,
    // one JWT audience, and one `ag_v_<hash12>` world database with two
    // writers. The unique index on (organization_id, name), now dropped, was
    // the only thing standing between the platform and that violation.
    const twin: CompileDeps = { ...deps, agentId: "the-other-untitled-agent" };
    expect(computeAgentHash(definition, twin)).not.toBe(
      computeAgentHash(definition, deps),
    );
    // And it must hold end-to-end, not just in the pre-computed hash the
    // build cache looks up: compile() bakes the hash into the emitted
    // platform-auth audience.
    expect(compile(definition, twin).hash).not.toBe(
      compile(definition, deps).hash,
    );
    expect(compile(definition, twin).hash).toBe(
      computeAgentHash(definition, twin),
    );
  });

  test("the agent id is IDENTITY, not emitted — a rename keeps it while re-keying", () => {
    // Renaming changes the slug (and so the hash, and so the world DB) but
    // not the identity input. Both halves are load-bearing: the first is the
    // accepted rename churn (spec §7), the second is what keeps two
    // same-named agents apart.
    const renamed: CompileDeps = { ...deps, agentSlug: "renamed-agent" };
    expect(compile(definition, renamed).hash).not.toBe(
      compile(definition, deps).hash,
    );
    for (const content of compile(definition, renamed).files.values()) {
      expect(content).not.toInclude(deps.agentId);
    }
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

  test("an ABSENT definition effort hashes like an explicit undefined", () => {
    // Inheriting is the absence of a value, not a value — canonicalJson drops
    // undefined object entries, so a draft that never wrote the key and one
    // that cleared it must land on the same artifact.
    const { definition: inheriting, deps: inheritingDeps } = basicFixture;
    const cleared = {
      ...inheriting,
      model: { ...inheriting.model, reasoning: undefined },
    } as typeof inheriting;
    expect(computeAgentHash(cleared, inheritingDeps)).toBe(
      computeAgentHash(inheriting, inheritingDeps),
    );
  });

  test("an EXPLICIT definition effort differs from inheriting the same value", () => {
    // The override is part of the published definition even when it happens
    // to agree with the preset: it pins the effort against a later preset
    // re-point, so the two are genuinely different agents.
    const { definition: inheriting, deps: inheritingDeps } = basicFixture;
    const pinned = {
      ...inheriting,
      model: {
        ...inheriting.model,
        reasoning: inheritingDeps.resolvedModel.reasoning,
      },
    } as typeof inheriting;
    expect(computeAgentHash(pinned, inheritingDeps)).not.toBe(
      computeAgentHash(inheriting, inheritingDeps),
    );
  });

  test("IDENTICAL definitions resolved under different preset efforts hash differently", () => {
    // The inheritance proof: nothing in the definition distinguishes these
    // two agents — only the effort the control plane resolved from their
    // presets does. If ResolvedModel.reasoning were not hashed, the second
    // would cache-hit the first's artifact and silently run at its effort.
    const { definition, deps } = basicFixture;
    const quick: CompileDeps = {
      ...deps,
      resolvedModel: { ...deps.resolvedModel, reasoning: "low" },
    };
    expect(computeAgentHash(definition, quick)).not.toBe(
      computeAgentHash(definition, deps),
    );
    expect(compile(definition, quick).hash).not.toBe(
      compile(definition, deps).hash,
    );
  });

  test("provider flip changes the hash", () => {
    const flipped: CompileDeps = {
      ...basicFixture.deps,
      resolvedModel: {
        ...basicFixture.deps.resolvedModel,
        provider: "anthropic",
        modelId: "claude-opus-4-8",
      },
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
