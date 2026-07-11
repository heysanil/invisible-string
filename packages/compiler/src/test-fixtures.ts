/**
 * Shared fixture inputs for the compiler test suites (golden files, hash
 * properties, and the gated `eve build` smoke test). Each fixture is a
 * complete (definition, deps) pair; golden outputs live under
 * packages/compiler/fixtures/<name>/.
 */
import type { AgentDefinition } from "@invisible-string/shared";

import versionsJson from "../versions.json";
import type { CompileDeps, RuntimeVersions } from "./types";

export const TEST_VERSIONS: RuntimeVersions = versionsJson;

export interface CompilerFixture {
  readonly name: string;
  readonly definition: AgentDefinition;
  readonly deps: CompileDeps;
}

/** Minimal agent: persona only, no context, openrouter model, prod build. */
export const basicFixture: CompilerFixture = {
  name: "basic",
  definition: {
    persona:
      "You are a capable general-purpose assistant for this workspace. Be concise, be accurate, and use the tools available to you rather than guessing.",
    model: { preset: "balanced", reasoning: "medium" },
    context: { mcpConnectionIds: [], skillIds: [] },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: { provider: "openrouter", modelId: "deepseek/deepseek-v4-pro" },
    workspaceSlug: "acme",
    agentSlug: "general-purpose",
    connections: [],
    skills: [],
  },
};

/** Bearer-auth MCP connection + PACKAGED skill (SKILL.md + files) + @refs. */
export const mcpSkillFixture: CompilerFixture = {
  name: "mcp-skill",
  definition: {
    persona: [
      "You are a pragmatic senior software engineer. Prefer small verifiable steps, cite the exact files and commands you rely on, and never fabricate output.",
      "",
      "Research repositories with @deepwiki before answering questions about their code, and follow @skill.release-notes whenever you draft release notes.",
    ].join("\n"),
    model: { preset: "powerful", reasoning: "high" },
    context: {
      mcpConnectionIds: ["7d3f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6"],
      skillIds: ["9c8b7a65-4d3e-4f20-8191-a2b3c4d5e6f7"],
    },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: {
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
    },
    workspaceSlug: "acme",
    agentSlug: "software-engineer",
    connections: [
      {
        id: "7d3f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6",
        slug: "deepwiki",
        url: "https://mcp.deepwiki.com/mcp",
        description:
          "DeepWiki: AI-generated documentation for public GitHub repositories. Use to look up a repo's structure, docs, or answer questions about its code.",
        auth: { kind: "bearerToken" },
        tools: { allow: ["read_wiki_structure", "read_wiki_contents", "ask_question"] },
        approval: { mode: "once" },
      },
    ],
    skills: [
      {
        id: "9c8b7a65-4d3e-4f20-8191-a2b3c4d5e6f7",
        slug: "release-notes",
        description:
          "Use when drafting release notes or changelogs for a repository.",
        markdown: [
          "# Release notes format",
          "",
          "1. Lead with the user-facing impact, one sentence per change.",
          "2. Group by Added / Changed / Fixed.",
          "3. Link every item to its PR or commit.",
        ].join("\n"),
        files: {
          "references/rota.md": "# On-call rota\n\n- weekdays: alice\n- weekends: bob\n",
        },
      },
    ],
  },
};

/** Headers-auth connection + custom per-tool approval policy + tool filters. */
export const customApprovalFixture: CompilerFixture = {
  name: "custom-approval",
  definition: {
    persona:
      "You keep the company CMS in sync: create and update pages in @cms, and consult @deepwiki when the content references a repository. Never publish or delete anything without an explicit go-ahead.",
    model: { preset: "balanced", reasoning: "medium" },
    context: {
      mcpConnectionIds: [
        "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
        "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f",
      ],
      skillIds: [],
    },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: { provider: "openrouter", modelId: "deepseek/deepseek-v4-pro" },
    workspaceSlug: "acme",
    agentSlug: "cms-sync",
    connections: [
      {
        id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
        slug: "cms",
        url: "https://cms.example.com/mcp",
        description: "Company CMS: create, update, publish, and delete pages.",
        auth: { kind: "headers", headers: { "X-Api-Key": "MCP_CMS_API_KEY" } },
        tools: { allow: ["get_page", "create_draft", "publish_page", "delete_page"] },
        approval: {
          mode: "custom",
          rules: [
            { tool: "delete_page", decision: "deny" },
            { tool: "publish_page", decision: "ask" },
            { tool: "get_page", decision: "allow" },
          ],
          fallback: "ask",
        },
      },
      {
        id: "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f",
        slug: "deepwiki",
        url: "https://mcp.deepwiki.com/mcp",
        description:
          "DeepWiki: AI-generated documentation for public GitHub repositories.",
        auth: { kind: "none" },
        approval: { mode: "never" },
      },
    ],
    skills: [],
  },
};

/**
 * FLAT skill (markdown only, no files → `agent/skills/<slug>.md`) + the
 * seeded "powerful" preset model (z-ai/glm-5.2). Pins two emitted-surface
 * branches no other fixture reaches, so the golden digest guards them:
 * the flat-skill emission path (emitSkill's no-files branch — mcp-skill
 * only covers the packaged directory form) and the
 * OPENROUTER_CONTEXT_WINDOW_TOKENS entry for z-ai/glm-5.2 (codegen/agent.ts
 * compaction threshold — a silent change here must fail the version-bump
 * guard, not cache-hit stale artifacts).
 */
export const flatSkillFixture: CompilerFixture = {
  name: "flat-skill",
  definition: {
    persona:
      "You are the on-call communications writer. Draft succinct incident updates and follow @skill.incident-updates for structure and tone.",
    model: { preset: "powerful", reasoning: "medium" },
    context: {
      mcpConnectionIds: [],
      skillIds: ["1a2b3c4d-5e6f-4a70-8b91-c2d3e4f5a6b7"],
    },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: { provider: "openrouter", modelId: "z-ai/glm-5.2" },
    workspaceSlug: "acme",
    agentSlug: "incident-writer",
    connections: [],
    skills: [
      {
        id: "1a2b3c4d-5e6f-4a70-8b91-c2d3e4f5a6b7",
        slug: "incident-updates",
        description:
          "Use when writing customer-facing incident status updates.",
        markdown: [
          "# Incident updates",
          "",
          "1. State impact first, in plain language.",
          "2. Give the next-update time explicitly.",
          "3. Never speculate about root cause before mitigation.",
        ].join("\n"),
      },
    ],
  },
};

/** Anthropic provider + explicit modelId override (matching), dev build. */
export const anthropicModelFixture: CompilerFixture = {
  name: "anthropic-model",
  definition: {
    persona:
      "You are a careful support triage specialist. Classify severity first (S1-S4), then route the report to the right owner with a crisp one-paragraph summary.",
    model: { preset: "powerful", modelId: "claude-opus-4-8", reasoning: "low" },
    context: { mcpConnectionIds: [], skillIds: [] },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: { provider: "anthropic", modelId: "claude-opus-4-8" },
    workspaceSlug: "acme",
    agentSlug: "support-triage",
    connections: [],
    skills: [],
    options: { dev: true },
  },
};

export const ALL_FIXTURES: readonly CompilerFixture[] = [
  basicFixture,
  mcpSkillFixture,
  customApprovalFixture,
  flatSkillFixture,
  anthropicModelFixture,
];
