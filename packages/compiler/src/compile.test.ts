import { describe, expect, test } from "bun:test";

import type { AgentDefinition } from "@invisible-string/shared";

import { compile } from "./compile";
import { CompileError, type CompileErrorCode } from "./errors";
import {
  anthropicModelFixture,
  basicFixture,
  customApprovalFixture,
  mcpSkillFixture,
  ALL_FIXTURES,
} from "./test-fixtures";
import type { CompileDeps } from "./types";

function expectCompileError(
  code: CompileErrorCode,
  definition: AgentDefinition,
  deps: CompileDeps,
): CompileError {
  try {
    compile(definition, deps);
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);
    const compileError = error as CompileError;
    expect(compileError.code).toBe(code);
    return compileError;
  }
  throw new Error(`expected compile() to throw CompileError ${code}`);
}

function withPersona(
  definition: AgentDefinition,
  persona: string,
): AgentDefinition {
  return { ...definition, persona };
}

describe("emitted file sets", () => {
  test("basic: eve channel only, no env lib", () => {
    const { files } = compile(basicFixture.definition, basicFixture.deps);
    expect([...files.keys()].sort()).toEqual([
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/instructions.md",
      "agent/lib/platform-auth.ts",
      "package.json",
      "tsconfig.json",
    ]);
  });

  test("mcp-skill: env lib + connection + packaged skill directory", () => {
    const { files } = compile(mcpSkillFixture.definition, mcpSkillFixture.deps);
    expect([...files.keys()].sort()).toEqual([
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/connections/deepwiki.ts",
      "agent/instructions.md",
      "agent/lib/env.ts",
      "agent/lib/platform-auth.ts",
      "agent/skills/release-notes/SKILL.md",
      "agent/skills/release-notes/references/rota.md",
      "package.json",
      "tsconfig.json",
    ]);
    expect(files.has("agent/skills/release-notes.md")).toBe(false);
  });

  test("artifacts are trigger-agnostic: no fixture emits trigger channels, schedules, or outbound libs", () => {
    for (const fixture of ALL_FIXTURES) {
      const { files } = compile(fixture.definition, fixture.deps);
      const paths = [...files.keys()];
      expect(
        paths.filter((path) => path.startsWith("agent/channels/")),
        fixture.name,
      ).toEqual(["agent/channels/eve.ts"]);
      expect(paths.some((path) => path.startsWith("agent/schedules/")), fixture.name).toBe(false);
      expect(files.has("agent/lib/trigger-event.ts"), fixture.name).toBe(false);
      expect(files.has("agent/lib/slack.ts"), fixture.name).toBe(false);
    }
  });
});

describe("generated content invariants", () => {
  test("secrets discipline: generated code reads env, never values", () => {
    for (const fixture of [mcpSkillFixture, customApprovalFixture]) {
      const { files } = compile(fixture.definition, fixture.deps);
      const connectionFiles = [...files.entries()].filter(([path]) =>
        path.startsWith("agent/connections/"),
      );
      expect(connectionFiles.length).toBeGreaterThan(0);
      for (const [, content] of connectionFiles) {
        expect(content).not.toMatch(/Bearer\s+[A-Za-z0-9]{10,}/);
        expect(content).toContain("defineMcpClientConnection");
      }
    }
    const bearer = compile(mcpSkillFixture.definition, mcpSkillFixture.deps)
      .files.get("agent/connections/deepwiki.ts")!;
    expect(bearer).toContain('requireEnv("MCP_DEEPWIKI_TOKEN")');
    const headers = compile(customApprovalFixture.definition, customApprovalFixture.deps)
      .files.get("agent/connections/cms.ts")!;
    expect(headers).toContain('"X-Api-Key": requireEnv("MCP_CMS_API_KEY")');
    expect(headers).toContain("headers: () =>");
  });

  test("agent.ts: explicit model, definition reasoning, world-postgres world", () => {
    const openrouter = compile(mcpSkillFixture.definition, mcpSkillFixture.deps)
      .files.get("agent/agent.ts")!;
    expect(openrouter).toContain('const MODEL_ID = "deepseek/deepseek-v4-flash";');
    expect(openrouter).toContain("createOpenRouter({");
    expect(openrouter).toContain("process.env.OPENROUTER_BASE_URL");
    expect(openrouter).toContain('reasoning: "high",');
    expect(openrouter).toContain('world: "@workflow/world-postgres"');

    const anthropic = compile(anthropicModelFixture.definition, anthropicModelFixture.deps)
      .files.get("agent/agent.ts")!;
    expect(anthropic).toContain('anthropic("claude-opus-4-8")');
    expect(anthropic).not.toContain("createOpenRouter");
    // Reasoning always comes from the definition — no preset fallback chain.
    expect(anthropic).toContain('reasoning: "low",');
  });

  test("localDev() is emitted ONLY on dev builds", () => {
    const prod = compile(basicFixture.definition, basicFixture.deps)
      .files.get("agent/lib/platform-auth.ts")!;
    expect(prod).not.toContain("localDev");
    const dev = compile(anthropicModelFixture.definition, anthropicModelFixture.deps)
      .files.get("agent/lib/platform-auth.ts")!;
    expect(dev).toContain("localDev");
    expect(dev).toContain("[platformJwt(), localDev()]");
  });

  test("platform-auth bakes the version-bound agent-version audience", () => {
    const { files, hash } = compile(basicFixture.definition, basicFixture.deps);
    const auth = files.get("agent/lib/platform-auth.ts")!;
    expect(auth).toContain(`PLATFORM_JWT_AUDIENCE = "agent-version:${hash}"`);
    expect(auth).toContain('PLATFORM_JWT_ISSUER = "invisible-string"');
  });

  test("eve channel carries the agent identity line", () => {
    const channel = compile(basicFixture.definition, basicFixture.deps)
      .files.get("agent/channels/eve.ts")!;
    expect(channel).toContain(
      'Platform agent \\"general-purpose\\" in workspace \\"acme\\" (invisible-string).',
    );
    expect(channel).toContain("defaultEveAuth(ctx)");
  });

  test("custom approval compiles to a qualified-name policy", () => {
    const cms = compile(customApprovalFixture.definition, customApprovalFixture.deps)
      .files.get("agent/connections/cms.ts")!;
    expect(cms).toContain('const DENY_TOOLS: readonly string[] = ["cms__delete_page"];');
    expect(cms).toContain('const ASK_TOOLS: readonly string[] = ["cms__publish_page"];');
    expect(cms).toContain('const ALLOW_TOOLS: readonly string[] = ["cms__get_page"];');
    expect(cms).toContain('return "user-approval";');
    const deepwiki = compile(customApprovalFixture.definition, customApprovalFixture.deps)
      .files.get("agent/connections/deepwiki.ts")!;
    expect(deepwiki).toContain("approval: never(),");
    expect(deepwiki).not.toContain("auth:");
  });

  test("package.json pins exactly per provider, names agent--<ws>--<agent>, never emits a lockfile", () => {
    const { files } = compile(anthropicModelFixture.definition, anthropicModelFixture.deps);
    const manifest = JSON.parse(files.get("package.json")!) as {
      name: string;
      engines: { node: string };
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe("agent--acme--support-triage");
    expect(manifest.engines.node).toBe("24.x");
    expect(manifest.dependencies["@ai-sdk/anthropic"]).toBe(
      anthropicModelFixture.deps.versions.anthropicProvider,
    );
    expect(manifest.dependencies["@openrouter/ai-sdk-provider"]).toBeUndefined();
    expect(manifest.dependencies.eve).toBe(anthropicModelFixture.deps.versions.eve);
    expect(files.has("package-lock.json")).toBe(false);
    expect(files.has("bun.lock")).toBe(false);
  });
});

describe("instructions rendering", () => {
  test("persona refs become literal text; the appendix routes discovery", () => {
    const instructions = compile(mcpSkillFixture.definition, mcpSkillFixture.deps)
      .files.get("agent/instructions.md")!;
    expect(instructions).toContain('the "deepwiki" connection');
    expect(instructions).toContain('the "release-notes" skill');
    expect(instructions).not.toContain("@deepwiki");
    expect(instructions).not.toContain("@skill.release-notes");
    expect(instructions).toContain("pragmatic senior software engineer");
    expect(instructions).toContain("## Workspace context");
    expect(instructions).toContain("connection_search");
    expect(instructions).toContain("load_skill");
    // Trigger machinery is gone from compiled instructions entirely.
    expect(instructions).not.toContain("{{trigger");
    expect(instructions).not.toContain("Trigger data");
  });

  test("no appendix when the agent has no context", () => {
    const instructions = compile(basicFixture.definition, basicFixture.deps)
      .files.get("agent/instructions.md")!;
    expect(instructions).not.toContain("## Workspace context");
    expect(instructions.trim().endsWith("rather than guessing.")).toBe(true);
  });

  test("email addresses and escaped @ prose survive untouched", () => {
    const definition = withPersona(
      basicFixture.definition,
      "Contact hi@sanil.co when done. Mention no refs.",
    );
    const instructions = compile(definition, basicFixture.deps)
      .files.get("agent/instructions.md")!;
    expect(instructions).toContain("hi@sanil.co");
  });
});

describe("typed CompileError cases", () => {
  const base = mcpSkillFixture;

  test("INVALID_DEFINITION: malformed definition shape", () => {
    const bad = {
      ...base.definition,
      model: { preset: "galaxy-brain" },
    } as unknown as AgentDefinition;
    expectCompileError("INVALID_DEFINITION", bad, base.deps);
  });

  test("EMPTY_PERSONA", () => {
    expectCompileError(
      "EMPTY_PERSONA",
      withPersona(base.definition, "   \n"),
      base.deps,
    );
  });

  test("MODEL_MISMATCH: definition override differs from resolved model", () => {
    const withOverride: AgentDefinition = {
      ...base.definition,
      model: { ...base.definition.model, modelId: "z-ai/glm-5.2" },
    };
    expectCompileError("MODEL_MISMATCH", withOverride, base.deps);
  });

  test("INVALID_DEPS: unknown provider / empty model id / bad slug", () => {
    expectCompileError("INVALID_DEPS", base.definition, {
      ...base.deps,
      resolvedModel: { provider: "openai" as never, modelId: "gpt-5.5" },
    });
    expectCompileError("INVALID_DEPS", base.definition, {
      ...base.deps,
      resolvedModel: { provider: "openrouter", modelId: "  " },
    });
    expectCompileError("INVALID_SLUG", base.definition, {
      ...base.deps,
      agentSlug: "Software Engineer",
    });
    expectCompileError("INVALID_SLUG", base.definition, {
      ...base.deps,
      workspaceSlug: "Acme Inc",
    });
  });

  test("MISSING_CONNECTION / UNEXPECTED_CONNECTION / DUPLICATE_SLUG", () => {
    expectCompileError("MISSING_CONNECTION", base.definition, {
      ...base.deps,
      connections: [],
    });
    expectCompileError("UNEXPECTED_CONNECTION", base.definition, {
      ...base.deps,
      connections: [
        ...base.deps.connections,
        { ...base.deps.connections[0]!, id: "eeeeeeee-1111-4222-8333-444444444444", slug: "extra" },
      ],
    });
    const dupDeps: CompileDeps = {
      ...customApprovalFixture.deps,
      connections: customApprovalFixture.deps.connections.map((connection) => ({
        ...connection,
        slug: "same",
      })),
    };
    // The duplicated slug also orphans the persona refs, so use a persona
    // without connection refs to isolate the slug check.
    expectCompileError(
      "DUPLICATE_SLUG",
      withPersona(customApprovalFixture.definition, "Sync the payload."),
      dupDeps,
    );
  });

  test("MISSING_SKILL / UNEXPECTED_SKILL", () => {
    expectCompileError("MISSING_SKILL", base.definition, {
      ...base.deps,
      skills: [],
    });
    expectCompileError("UNEXPECTED_SKILL", base.definition, {
      ...base.deps,
      skills: [
        ...base.deps.skills,
        { ...base.deps.skills[0]!, id: "dddddddd-1111-4222-8333-444444444444", slug: "extra" },
      ],
    });
  });

  test("INVALID_DEPS: connection URLs may not smuggle credentials (secrets discipline gate)", () => {
    const withUrl = (url: string): CompileDeps => ({
      ...base.deps,
      connections: base.deps.connections.map((connection) => ({
        ...connection,
        url,
      })),
    });
    // Userinfo credentials in the URL literal.
    expectCompileError(
      "INVALID_DEPS",
      base.definition,
      withUrl("https://user:t0ken@mcp.example.com/mcp"),
    );
    // Credential-looking query parameters.
    expectCompileError(
      "INVALID_DEPS",
      base.definition,
      withUrl("https://mcp.example.com/mcp?api_key=abc123"),
    );
    expectCompileError(
      "INVALID_DEPS",
      base.definition,
      withUrl("https://mcp.example.com/mcp?access-token=abc123"),
    );
    // Not a URL at all.
    expectCompileError("INVALID_DEPS", base.definition, withUrl("not a url"));
    // Benign query parameters stay allowed.
    expect(() =>
      compile(base.definition, withUrl("https://mcp.example.com/mcp?version=2")),
    ).not.toThrow();
  });

  test("INVALID_HEADER: bad env var name (secrets discipline gate)", () => {
    expectCompileError("INVALID_HEADER", customApprovalFixture.definition, {
      ...customApprovalFixture.deps,
      connections: customApprovalFixture.deps.connections.map((connection) => ({
        ...connection,
        auth: { kind: "headers" as const, headers: { "X-Api-Key": "sk-live-SECRETVALUE" } },
      })),
    });
  });

  test("INVALID_TOOL_FILTER: both/neither/empty", () => {
    const withTools = (tools: unknown): CompileDeps => ({
      ...base.deps,
      connections: base.deps.connections.map((connection) => ({
        ...connection,
        tools: tools as never,
      })),
    });
    expectCompileError("INVALID_TOOL_FILTER", base.definition, withTools({ allow: ["a"], block: ["b"] }));
    expectCompileError("INVALID_TOOL_FILTER", base.definition, withTools({}));
    expectCompileError("INVALID_TOOL_FILTER", base.definition, withTools({ allow: [] }));
  });

  test("INVALID_APPROVAL: empty rules, qualified names, duplicates", () => {
    const withApproval = (approval: unknown): CompileDeps => ({
      ...base.deps,
      connections: base.deps.connections.map((connection) => ({
        ...connection,
        approval: approval as never,
      })),
    });
    expectCompileError(
      "INVALID_APPROVAL",
      base.definition,
      withApproval({ mode: "custom", rules: [], fallback: "ask" }),
    );
    expectCompileError(
      "INVALID_APPROVAL",
      base.definition,
      withApproval({
        mode: "custom",
        rules: [{ tool: "deepwiki__ask_question", decision: "ask" }],
        fallback: "ask",
      }),
    );
    expectCompileError(
      "INVALID_APPROVAL",
      base.definition,
      withApproval({
        mode: "custom",
        rules: [
          { tool: "ask_question", decision: "ask" },
          { tool: "ask_question", decision: "deny" },
        ],
        fallback: "allow",
      }),
    );
  });

  test("INVALID_SKILL_FILE: escaping paths rejected", () => {
    for (const path of ["../evil.md", "refs/../../evil.md", "/abs.md", "SKILL.md", ""]) {
      expectCompileError("INVALID_SKILL_FILE", base.definition, {
        ...base.deps,
        skills: base.deps.skills.map((skill) => ({
          ...skill,
          files: { [path]: "boom" },
        })),
      });
    }
  });
});

describe("@reference edge cases through compile()", () => {
  const base = basicFixture;

  test("UNRESOLVED_REFERENCE: unknown connection (prose @word)", () => {
    const error = expectCompileError(
      "UNRESOLVED_REFERENCE",
      withPersona(base.definition, "Ping @linear when done."),
      base.deps,
    );
    expect(error.details.name).toBe("linear");
  });

  test("UNRESOLVED_REFERENCE: unknown and bare skill refs", () => {
    expectCompileError(
      "UNRESOLVED_REFERENCE",
      withPersona(base.definition, "Follow @skill.nope."),
      base.deps,
    );
    expectCompileError(
      "UNRESOLVED_REFERENCE",
      withPersona(base.definition, "Follow @skill please."),
      base.deps,
    );
  });

  test("TRIGGER_REF_NOT_ALLOWED: any @trigger reference — agents are trigger-agnostic", () => {
    const error = expectCompileError(
      "TRIGGER_REF_NOT_ALLOWED",
      withPersona(base.definition, "Read @trigger.email and reply."),
      base.deps,
    );
    expect(error.message).toContain("agents are trigger-agnostic");
    // Bare @trigger is rejected the same way — no trigger vocabulary exists
    // in a persona at all.
    expectCompileError(
      "TRIGGER_REF_NOT_ALLOWED",
      withPersona(base.definition, "Use @trigger to decide."),
      base.deps,
    );
    // Even with context attached (rules out any interplay with resolution).
    expectCompileError(
      "TRIGGER_REF_NOT_ALLOWED",
      withPersona(mcpSkillFixture.definition, "Use @deepwiki on @trigger.repo."),
      mcpSkillFixture.deps,
    );
  });

  test("trailing dots and adjacent punctuation stay out of refs", () => {
    const { files } = compile(
      withPersona(mcpSkillFixture.definition, "Check @deepwiki. Then stop."),
      mcpSkillFixture.deps,
    );
    expect(files.get("agent/instructions.md")).toContain(
      'the "deepwiki" connection. Then stop.',
    );
  });
});
