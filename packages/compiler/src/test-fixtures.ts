/**
 * Shared fixture inputs for the compiler test suites (golden files, hash
 * properties, and the gated `eve build` smoke test). Each fixture is a
 * complete (definition, deps) pair; golden outputs live under
 * packages/compiler/fixtures/<name>/.
 */
import type { WorkflowDefinition } from "@invisible-string/shared";

import versionsJson from "../versions.json";
import type { CompileDeps, RuntimeVersions } from "./types";

export const TEST_VERSIONS: RuntimeVersions = versionsJson;

const GENERAL_PURPOSE_PRESET = {
  id: "0f8b6c1e-4a6f-4a5e-9b3d-1c2e3f405060",
  name: "General Purpose",
  persona:
    "You are a capable general-purpose assistant for this workspace. Be concise, be accurate, and use the tools available to you rather than guessing.",
} as const;

const SOFTWARE_ENGINEER_PRESET = {
  id: "2b1a0c9d-8e7f-4a5b-9c0d-e1f203041526",
  name: "Software Engineer",
  persona:
    "You are a pragmatic senior software engineer. Prefer small verifiable steps, cite the exact files and commands you rely on, and never fabricate output.",
  defaultReasoning: "medium",
} as const;

export interface CompilerFixture {
  readonly name: string;
  readonly definition: WorkflowDefinition;
  readonly deps: CompileDeps;
}

/** Minimal manual workflow: no context, openrouter model, prod build. */
export const manualOnlyFixture: CompilerFixture = {
  name: "manual-only",
  definition: {
    trigger: { type: "manual" },
    context: { mcpConnectionIds: [], skillIds: [] },
    agent: { agentPresetId: GENERAL_PURPOSE_PRESET.id },
    instructions: {
      markdown:
        "Answer workspace questions directly. When you are unsure, say so instead of guessing.",
    },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: { provider: "openrouter", modelId: "deepseek/deepseek-v4-pro" },
    workspaceSlug: "acme",
    workflowSlug: "helpdesk",
    agentPreset: GENERAL_PURPOSE_PRESET,
    connections: [],
    skills: [],
  },
};

/** Form trigger + bearer-auth MCP connection + flat skill + @refs. */
export const formMcpSkillFixture: CompilerFixture = {
  name: "form-mcp-skill",
  definition: {
    trigger: {
      type: "form",
      fields: [
        {
          key: "repo",
          label: "Repository",
          type: "text",
          required: true,
          placeholder: "vercel/workflow",
        },
        {
          key: "audience",
          label: "Audience",
          type: "select",
          required: true,
          options: ["engineering", "customers"],
        },
        {
          key: "notes",
          label: "Extra notes",
          type: "textarea",
          required: false,
        },
      ],
    },
    context: {
      mcpConnectionIds: ["7d3f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6"],
      skillIds: ["9c8b7a65-4d3e-4f20-8191-a2b3c4d5e6f7"],
    },
    agent: {
      agentPresetId: SOFTWARE_ENGINEER_PRESET.id,
      reasoning: "high",
    },
    instructions: {
      markdown: [
        "Draft release notes for @trigger.repo aimed at @trigger.audience.",
        "",
        "Research the repository with @deepwiki before writing anything, then follow @skill.release-notes for the format. Incorporate @trigger.notes when provided.",
      ].join("\n"),
    },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: {
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
    },
    workspaceSlug: "acme",
    workflowSlug: "release-notes",
    agentPreset: SOFTWARE_ENGINEER_PRESET,
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
      },
    ],
  },
};

/** Slack trigger, anthropic model, headers-auth connection, packaged skill, dev build. */
export const slackFixture: CompilerFixture = {
  name: "slack",
  definition: {
    trigger: {
      type: "slack",
      binding: {
        channelId: "C0123456789",
        mentionOnly: true,
        includeDirectMessages: false,
      },
    },
    context: {
      mcpConnectionIds: ["5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"],
      skillIds: ["3e2d1c0b-9a8f-4e7d-8c5b-4a3928170605"],
    },
    agent: { agentPresetId: GENERAL_PURPOSE_PRESET.id },
    instructions: {
      markdown:
        "Triage the report in @trigger.text using @docs, then reply in-thread following @skill.triage.",
    },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: { provider: "anthropic", modelId: "claude-opus-4-8" },
    workspaceSlug: "acme",
    workflowSlug: "support-triage",
    agentPreset: GENERAL_PURPOSE_PRESET,
    connections: [
      {
        id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
        slug: "docs",
        url: "https://docs.example.com/mcp",
        description:
          "Internal docs: search support runbooks, product pages, and owners.",
        auth: { kind: "headers", headers: { "X-Api-Key": "MCP_DOCS_API_KEY" } },
        tools: { block: ["delete_page", "publish_page"] },
        approval: { mode: "always" },
      },
    ],
    skills: [
      {
        id: "3e2d1c0b-9a8f-4e7d-8c5b-4a3928170605",
        slug: "triage",
        description: "Use when triaging an inbound support report.",
        markdown: [
          "Classify severity first (S1-S4), then route:",
          "check `references/rota.md` for the current owner.",
        ].join("\n"),
        files: {
          "references/rota.md": "# On-call rota\n\n- weekdays: @alice\n- weekends: @bob\n",
        },
      },
    ],
    options: { dev: true },
  },
};

/** Schedule trigger, no context. */
export const scheduleFixture: CompilerFixture = {
  name: "schedule",
  definition: {
    trigger: { type: "schedule", cron: "0 9 * * 1-5" },
    context: { mcpConnectionIds: [], skillIds: [] },
    agent: { agentPresetId: SOFTWARE_ENGINEER_PRESET.id },
    instructions: {
      markdown:
        "Every run: summarize the workspace's open work into a short digest. Keep it under ten bullet points.",
    },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: { provider: "openrouter", modelId: "z-ai/glm-5.2" },
    workspaceSlug: "acme",
    workflowSlug: "daily-digest",
    agentPreset: SOFTWARE_ENGINEER_PRESET,
    connections: [],
    skills: [],
  },
};

/** Webhook trigger + custom per-tool approval policy + a no-auth never() connection. */
export const customApprovalFixture: CompilerFixture = {
  name: "custom-approval",
  definition: {
    trigger: { type: "webhook" },
    context: {
      mcpConnectionIds: [
        "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
        "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f",
      ],
      skillIds: [],
    },
    agent: { agentPresetId: GENERAL_PURPOSE_PRESET.id },
    instructions: {
      markdown:
        "Process the incoming payload for @trigger.payload.id: sync it into @cms, and consult @deepwiki when the payload references a repository.",
    },
  },
  deps: {
    versions: TEST_VERSIONS,
    resolvedModel: { provider: "openrouter", modelId: "deepseek/deepseek-v4-pro" },
    workspaceSlug: "acme",
    workflowSlug: "cms-sync",
    agentPreset: GENERAL_PURPOSE_PRESET,
    connections: [
      {
        id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
        slug: "cms",
        url: "https://cms.example.com/mcp",
        description: "Company CMS: create, update, publish, and delete pages.",
        auth: { kind: "bearerToken" },
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

export const ALL_FIXTURES: readonly CompilerFixture[] = [
  manualOnlyFixture,
  formMcpSkillFixture,
  slackFixture,
  scheduleFixture,
  customApprovalFixture,
];
