import { describe, expect, test } from "bun:test";

import type { WorkflowDefinition } from "@invisible-string/shared";

import { compile } from "./compile";
import { CompileError, type CompileErrorCode } from "./errors";
import {
  customApprovalFixture,
  formMcpSkillFixture,
  manualOnlyFixture,
  scheduleFixture,
  slackFixture,
} from "./test-fixtures";
import type { CompileDeps } from "./types";

function expectCompileError(
  code: CompileErrorCode,
  definition: WorkflowDefinition,
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

function withInstructions(
  definition: WorkflowDefinition,
  markdown: string,
): WorkflowDefinition {
  return { ...definition, instructions: { markdown } };
}

describe("emitted file sets", () => {
  test("manual-only: eve channel only, no trigger/env libs", () => {
    const { files } = compile(manualOnlyFixture.definition, manualOnlyFixture.deps);
    expect([...files.keys()].sort()).toEqual([
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/instructions.md",
      "agent/lib/platform-auth.ts",
      "package.json",
      "tsconfig.json",
    ]);
  });

  test("form fixture: trigger channel + libs + connection + flat skill", () => {
    const { files } = compile(formMcpSkillFixture.definition, formMcpSkillFixture.deps);
    expect([...files.keys()].sort()).toEqual([
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/channels/form.ts",
      "agent/connections/deepwiki.ts",
      "agent/instructions.md",
      "agent/lib/env.ts",
      "agent/lib/platform-auth.ts",
      "agent/lib/trigger-event.ts",
      "agent/skills/release-notes.md",
      "package.json",
      "tsconfig.json",
    ]);
  });

  test("slack fixture: packaged skill directory + slack channel", () => {
    const { files } = compile(slackFixture.definition, slackFixture.deps);
    expect(files.has("agent/channels/slack.ts")).toBe(true);
    expect(files.has("agent/skills/triage/SKILL.md")).toBe(true);
    expect(files.has("agent/skills/triage/references/rota.md")).toBe(true);
    expect(files.has("agent/skills/triage.md")).toBe(false);
  });

  test("schedule fixture: schedules file, no trigger channel or trigger lib", () => {
    const { files } = compile(scheduleFixture.definition, scheduleFixture.deps);
    expect(files.has("agent/schedules/schedule.ts")).toBe(true);
    expect(files.has("agent/lib/trigger-event.ts")).toBe(false);
    expect([...files.keys()].some((path) => path.startsWith("agent/channels/") && path !== "agent/channels/eve.ts")).toBe(false);
  });
});

describe("generated content invariants", () => {
  test("secrets discipline: generated code reads env, never values", () => {
    for (const fixture of [formMcpSkillFixture, slackFixture, customApprovalFixture]) {
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
    const bearer = compile(formMcpSkillFixture.definition, formMcpSkillFixture.deps)
      .files.get("agent/connections/deepwiki.ts")!;
    expect(bearer).toContain('requireEnv("MCP_DEEPWIKI_TOKEN")');
    const headers = compile(slackFixture.definition, slackFixture.deps)
      .files.get("agent/connections/docs.ts")!;
    expect(headers).toContain('"X-Api-Key": requireEnv("MCP_DOCS_API_KEY")');
    expect(headers).toContain("headers: () =>");
  });

  test("agent.ts: explicit model, reasoning, world-postgres world", () => {
    const openrouter = compile(formMcpSkillFixture.definition, formMcpSkillFixture.deps)
      .files.get("agent/agent.ts")!;
    expect(openrouter).toContain('const MODEL_ID = "deepseek/deepseek-v4-flash";');
    expect(openrouter).toContain("createOpenRouter({");
    expect(openrouter).toContain("process.env.OPENROUTER_BASE_URL");
    expect(openrouter).toContain('reasoning: "high",');
    expect(openrouter).toContain('world: "@workflow/world-postgres"');

    const anthropic = compile(slackFixture.definition, slackFixture.deps)
      .files.get("agent/agent.ts")!;
    expect(anthropic).toContain('anthropic("claude-opus-4-8")');
    expect(anthropic).not.toContain("createOpenRouter");
    // No reasoning override and no preset default on this fixture.
    expect(anthropic).not.toContain("reasoning:");
  });

  test("preset default reasoning applies when the definition has no override", () => {
    const agent = compile(scheduleFixture.definition, scheduleFixture.deps)
      .files.get("agent/agent.ts")!;
    expect(agent).toContain('reasoning: "medium",');
  });

  test("localDev() is emitted ONLY on dev builds", () => {
    const prod = compile(formMcpSkillFixture.definition, formMcpSkillFixture.deps)
      .files.get("agent/lib/platform-auth.ts")!;
    expect(prod).not.toContain("localDev");
    const dev = compile(slackFixture.definition, slackFixture.deps)
      .files.get("agent/lib/platform-auth.ts")!;
    expect(dev).toContain("localDev");
    expect(dev).toContain("[platformJwt(), localDev()]");
  });

  test("trigger channels mount at /eve/v1/platform/<trigger> and pass the continuation token through", () => {
    const form = compile(formMcpSkillFixture.definition, formMcpSkillFixture.deps)
      .files.get("agent/channels/form.ts")!;
    expect(form).toContain('POST("/eve/v1/platform/form"');
    expect(form).toContain("event.continuationToken ??");
    expect(form).toContain("routeAuth(req, platformAuth())");
    expect(form).toContain("PLATFORM_CALLBACK_URL");

    const slack = compile(slackFixture.definition, slackFixture.deps)
      .files.get("agent/channels/slack.ts")!;
    expect(slack).toContain('POST<SlackReplyTarget>("/eve/v1/platform/slack"');
    expect(slack).toContain("chat.postMessage");
    expect(slack).toContain("SLACK_BOT_TOKEN");
  });

  test("trigger ref markers are baked into the channel", () => {
    const form = compile(formMcpSkillFixture.definition, formMcpSkillFixture.deps)
      .files.get("agent/channels/form.ts")!;
    expect(form).toContain('const TRIGGER_REFS: readonly string[] = ["repo", "audience", "notes"];');
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

  test("package.json pins exactly per provider and never emits a lockfile", () => {
    const { files } = compile(slackFixture.definition, slackFixture.deps);
    const manifest = JSON.parse(files.get("package.json")!) as {
      engines: { node: string };
      dependencies: Record<string, string>;
    };
    expect(manifest.engines.node).toBe("24.x");
    expect(manifest.dependencies["@ai-sdk/anthropic"]).toBe(
      slackFixture.deps.versions.anthropicProvider,
    );
    expect(manifest.dependencies["@openrouter/ai-sdk-provider"]).toBeUndefined();
    expect(manifest.dependencies.eve).toBe(slackFixture.deps.versions.eve);
    expect(files.has("package-lock.json")).toBe(false);
    expect(files.has("bun.lock")).toBe(false);
  });
});

describe("instructions rendering", () => {
  test("compile-time refs become literal text; trigger refs become {{markers}}", () => {
    const instructions = compile(formMcpSkillFixture.definition, formMcpSkillFixture.deps)
      .files.get("agent/instructions.md")!;
    expect(instructions).toContain("{{trigger.repo}}");
    expect(instructions).toContain("{{trigger.audience}}");
    expect(instructions).toContain('the "deepwiki" connection');
    expect(instructions).toContain('the "release-notes" skill');
    expect(instructions).not.toContain("@deepwiki");
    expect(instructions).not.toContain("@skill.release-notes");
    // Persona block + descriptions appendix.
    expect(instructions).toContain("pragmatic senior software engineer");
    expect(instructions).toContain("## Workspace context");
    expect(instructions).toContain("connection_search");
    expect(instructions).toContain("load_skill");
  });

  test("email addresses and escaped @ prose survive untouched", () => {
    const definition = withInstructions(
      manualOnlyFixture.definition,
      "Contact hi@sanil.co when done. Mention no refs.",
    );
    const instructions = compile(definition, manualOnlyFixture.deps)
      .files.get("agent/instructions.md")!;
    expect(instructions).toContain("hi@sanil.co");
  });
});

describe("typed CompileError cases", () => {
  const base = formMcpSkillFixture;

  test("INVALID_DEFINITION: malformed definition shape", () => {
    const bad = {
      ...base.definition,
      trigger: { type: "form", fields: [] },
    } as unknown as WorkflowDefinition;
    expectCompileError("INVALID_DEFINITION", bad, base.deps);
  });

  test("EMPTY_INSTRUCTIONS", () => {
    expectCompileError(
      "EMPTY_INSTRUCTIONS",
      withInstructions(base.definition, "   \n"),
      base.deps,
    );
  });

  test("AGENT_PRESET_MISMATCH", () => {
    expectCompileError("AGENT_PRESET_MISMATCH", base.definition, {
      ...base.deps,
      agentPreset: { ...base.deps.agentPreset, id: "11111111-2222-4333-8444-555555555555" },
    });
  });

  test("MODEL_MISMATCH: definition override differs from resolved model", () => {
    const withOverride: WorkflowDefinition = {
      ...base.definition,
      agent: { ...base.definition.agent, modelId: "z-ai/glm-5.2" },
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
      workflowSlug: "Release Notes",
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
    // The duplicated slug also orphans the instructions refs, so use a
    // definition without connection refs to isolate the slug check.
    expectCompileError(
      "DUPLICATE_SLUG",
      withInstructions(customApprovalFixture.definition, "Sync the payload."),
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
    expectCompileError("INVALID_HEADER", slackFixture.definition, {
      ...slackFixture.deps,
      connections: slackFixture.deps.connections.map((connection) => ({
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
      expectCompileError("INVALID_SKILL_FILE", slackFixture.definition, {
        ...slackFixture.deps,
        skills: slackFixture.deps.skills.map((skill) => ({
          ...skill,
          files: { [path]: "boom" },
        })),
      });
    }
  });
});

describe("@reference edge cases through compile()", () => {
  const base = manualOnlyFixture;

  test("UNRESOLVED_REFERENCE: unknown connection (prose @word)", () => {
    const error = expectCompileError(
      "UNRESOLVED_REFERENCE",
      withInstructions(base.definition, "Ping @linear when done."),
      base.deps,
    );
    expect(error.details.name).toBe("linear");
  });

  test("UNRESOLVED_REFERENCE: unknown and bare skill refs", () => {
    expectCompileError(
      "UNRESOLVED_REFERENCE",
      withInstructions(base.definition, "Follow @skill.nope."),
      base.deps,
    );
    expectCompileError(
      "UNRESOLVED_REFERENCE",
      withInstructions(base.definition, "Follow @skill please."),
      base.deps,
    );
  });

  test("UNRESOLVED_REFERENCE: bare @trigger", () => {
    expectCompileError(
      "UNRESOLVED_REFERENCE",
      withInstructions(formMcpSkillFixture.definition, "Use @trigger to decide."),
      formMcpSkillFixture.deps,
    );
  });

  test("TRIGGER_REF_NOT_ALLOWED: manual and schedule triggers carry no data", () => {
    expectCompileError(
      "TRIGGER_REF_NOT_ALLOWED",
      withInstructions(base.definition, "Read @trigger.email."),
      base.deps,
    );
    expectCompileError(
      "TRIGGER_REF_NOT_ALLOWED",
      withInstructions(scheduleFixture.definition, "Read @trigger.email."),
      scheduleFixture.deps,
    );
  });

  test("TRIGGER_REF_UNKNOWN_FIELD: form refs must match a field key", () => {
    const error = expectCompileError(
      "TRIGGER_REF_UNKNOWN_FIELD",
      withInstructions(formMcpSkillFixture.definition, "Read @trigger.missing_field."),
      formMcpSkillFixture.deps,
    );
    expect(error.details.fieldKey).toBe("missing_field");
  });

  test("form refs may address nested paths under a known field key", () => {
    const { files } = compile(
      withInstructions(formMcpSkillFixture.definition, "Read @trigger.notes.extra of @trigger.repo."),
      formMcpSkillFixture.deps,
    );
    expect(files.get("agent/instructions.md")).toContain("{{trigger.notes.extra}}");
  });

  test("webhook refs accept arbitrary payload paths", () => {
    const { files } = compile(
      withInstructions(customApprovalFixture.definition, "Handle @trigger.payload.items.0.sku via @cms and @deepwiki."),
      customApprovalFixture.deps,
    );
    expect(files.get("agent/instructions.md")).toContain("{{trigger.payload.items.0.sku}}");
    const webhook = files.get("agent/channels/webhook.ts")!;
    expect(webhook).toContain('["payload.items.0.sku"]');
  });

  test("duplicate trigger refs bake into the channel once", () => {
    const { files } = compile(
      withInstructions(
        formMcpSkillFixture.definition,
        "Use @trigger.repo, then re-check @trigger.repo.",
      ),
      formMcpSkillFixture.deps,
    );
    expect(files.get("agent/channels/form.ts")).toContain(
      'const TRIGGER_REFS: readonly string[] = ["repo"];',
    );
  });

  test("trailing dots and adjacent punctuation stay out of refs", () => {
    const { files } = compile(
      withInstructions(formMcpSkillFixture.definition, "Check @trigger.repo. Then stop."),
      formMcpSkillFixture.deps,
    );
    expect(files.get("agent/instructions.md")).toContain("{{trigger.repo}}. Then stop.");
  });
});
