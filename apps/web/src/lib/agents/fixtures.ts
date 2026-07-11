/**
 * Canned agents for fixture mode (VITE_FIXTURE_MODE=1). Four agents cover
 * the full state matrix the grid + editor must render:
 *
 *   1. Executive assistant — published, rich context (3 connections + 2
 *      skills), balanced preset.
 *   2. Support triager     — published, specific-model override + high
 *      reasoning.
 *   3. Release bot         — draft, never published.
 *   4. Data analyst        — published but the published version's build
 *      FAILED (error chip states).
 *
 * Same frozen-DTO discipline as src/lib/chat/fixtures.ts: every object is a
 * real shared DTO shape so fixture screens exercise the exact production
 * component contracts. Ids are stable uuids because the editor's
 * `initAgentEditorState` zod-parses `agent.draft` (`parseAgentDefinition`) —
 * non-uuid context ids would silently degrade to an empty definition.
 */
import type {
  AgentDefinition,
  AgentDto,
  AgentSummaryDto,
  McpConnectionDto,
  SkillDto,
  WorkspaceMemberDto,
} from "@invisible-string/shared";

const NOW = "2026-07-09T09:00:00.000Z";
const EARLIER = "2026-07-01T09:00:00.000Z";

// ── Stable ids (exported so screens can pair resources/sessions) ───────────

export const FIXTURE_AGENT_IDS = {
  execAssistant: "aaaaaaaa-0001-4000-8000-000000000001",
  supportTriager: "aaaaaaaa-0002-4000-8000-000000000002",
  releaseBot: "aaaaaaaa-0003-4000-8000-000000000003",
  dataAnalyst: "aaaaaaaa-0004-4000-8000-000000000004",
} as const;

export const FIXTURE_CONNECTION_IDS = {
  gmail: "11111111-aaaa-4aaa-8aaa-111111111111",
  calendar: "22222222-aaaa-4aaa-8aaa-222222222222",
  linear: "33333333-aaaa-4aaa-8aaa-333333333333",
} as const;

export const FIXTURE_SKILL_IDS = {
  meetingNotes: "44444444-bbbb-4bbb-8bbb-444444444444",
  triagePlaybook: "55555555-bbbb-4bbb-8bbb-555555555555",
} as const;

export const FIXTURE_OWNER_USER_ID = "user_fixture_owner";

/** Error log surfaced for the Data analyst's failed published build. */
export const FIXTURE_BUILD_ERROR =
  "eve build failed: agent/agent.ts(12,3) — model \"internal/warehouse-1\" is not available to this project.";

// ── Context resources the fixture agents attach ────────────────────────────

function connection(
  id: string,
  name: string,
  description: string,
): McpConnectionDto {
  return {
    id,
    scope: "workspace",
    name,
    description,
    source: "registry",
    registryId: `io.github.fixtures/${name}`,
    url: `https://mcp.example.com/${name}`,
    toolAllow: null,
    toolBlock: null,
    approvalPolicy: { default: "never" },
    enabled: true,
    hasCredentials: true,
    createdAt: EARLIER,
    updatedAt: EARLIER,
  };
}

function skill(id: string, name: string, description: string): SkillDto {
  return {
    id,
    scope: "workspace",
    name,
    description,
    content: `# ${name}\n\nFixture skill body.`,
    files: [],
    createdAt: EARLIER,
    updatedAt: EARLIER,
  };
}

export const FIXTURE_AGENT_CONNECTIONS: readonly McpConnectionDto[] = [
  connection(FIXTURE_CONNECTION_IDS.gmail, "gmail", "Read and send email."),
  connection(
    FIXTURE_CONNECTION_IDS.calendar,
    "google-calendar",
    "Look up and schedule events.",
  ),
  connection(
    FIXTURE_CONNECTION_IDS.linear,
    "linear",
    "Search, create, and update issues.",
  ),
];

export const FIXTURE_AGENT_SKILLS: readonly SkillDto[] = [
  skill(
    FIXTURE_SKILL_IDS.meetingNotes,
    "meeting-notes",
    "Structure meeting notes into decisions and action items.",
  ),
  skill(
    FIXTURE_SKILL_IDS.triagePlaybook,
    "triage-playbook",
    "Classify inbound reports by severity and route them.",
  ),
];

/** Members for the Access section's run-as picker. */
export const FIXTURE_MEMBERS: readonly WorkspaceMemberDto[] = [
  {
    id: "member_fixture_owner",
    userId: FIXTURE_OWNER_USER_ID,
    name: "Avery Chen",
    email: "avery@acme.com",
    role: "owner",
    createdAt: EARLIER,
  },
  {
    id: "member_fixture_ops",
    userId: "user_fixture_ops",
    name: "Sam Okafor",
    email: "sam@acme.com",
    role: "member",
    createdAt: EARLIER,
  },
];

// ── The agents ──────────────────────────────────────────────────────────────

export interface FixtureAgent {
  /** List projection — what the card grid renders. */
  summary: AgentSummaryDto;
  /** Full row — what the editor route loads (draft served as stored). */
  agent: AgentDto;
  /** Parsed definition — seed for the editor's local reducer. */
  definition: AgentDefinition;
}

function fixtureAgent(input: {
  id: string;
  name: string;
  description: string | null;
  definition: AgentDefinition;
  published: boolean;
  buildStatus?: AgentSummaryDto["buildStatus"];
}): FixtureAgent {
  const versionId = input.published
    ? input.id.replace("aaaaaaaa", "bbbbbbbb")
    : null;
  return {
    summary: {
      id: input.id,
      name: input.name,
      description: input.description,
      runAsUserId: FIXTURE_OWNER_USER_ID,
      publishedVersionId: versionId,
      publishedAt: input.published ? EARLIER : null,
      buildStatus: input.published ? (input.buildStatus ?? "succeeded") : null,
      createdAt: EARLIER,
      updatedAt: NOW,
    },
    agent: {
      id: input.id,
      name: input.name,
      description: input.description,
      runAsUserId: FIXTURE_OWNER_USER_ID,
      draft: input.definition,
      publishedVersionId: versionId,
      createdAt: EARLIER,
      updatedAt: NOW,
    },
    definition: input.definition,
  };
}

export const FIXTURE_EXEC_ASSISTANT: FixtureAgent = fixtureAgent({
  id: FIXTURE_AGENT_IDS.execAssistant,
  name: "Executive assistant",
  description: "Handles email, calendar, and follow-ups across the team.",
  definition: {
    persona: [
      "You are a meticulous executive assistant.",
      "",
      "Triage email with @gmail, keep the calendar honest with",
      "@google-calendar, and turn every meeting into decisions and action",
      "items using @skill.meeting-notes. Confirm before sending anything",
      "external.",
    ].join("\n"),
    model: { preset: "balanced", reasoning: "medium" },
    context: {
      mcpConnectionIds: [
        FIXTURE_CONNECTION_IDS.gmail,
        FIXTURE_CONNECTION_IDS.calendar,
        FIXTURE_CONNECTION_IDS.linear,
      ],
      skillIds: [
        FIXTURE_SKILL_IDS.meetingNotes,
        FIXTURE_SKILL_IDS.triagePlaybook,
      ],
    },
  },
  published: true,
});

export const FIXTURE_SUPPORT_TRIAGER: FixtureAgent = fixtureAgent({
  id: FIXTURE_AGENT_IDS.supportTriager,
  name: "Support triager",
  description: "Classifies inbound reports and files clean issues.",
  definition: {
    persona: [
      "You are a support triage specialist. Classify every inbound report",
      "by severity using @skill.triage-playbook, then file or update the",
      "matching issue in @linear. Never close an issue without a reproduction.",
    ].join("\n"),
    model: {
      preset: "quick",
      modelId: "deepseek/deepseek-v4-pro",
      reasoning: "high",
    },
    context: {
      mcpConnectionIds: [FIXTURE_CONNECTION_IDS.linear],
      skillIds: [FIXTURE_SKILL_IDS.triagePlaybook],
    },
  },
  published: true,
});

export const FIXTURE_RELEASE_BOT: FixtureAgent = fixtureAgent({
  id: FIXTURE_AGENT_IDS.releaseBot,
  name: "Release bot",
  description: null,
  definition: {
    persona: "",
    model: { preset: "powerful", reasoning: "medium" },
    context: { mcpConnectionIds: [], skillIds: [] },
  },
  published: false,
});

export const FIXTURE_DATA_ANALYST: FixtureAgent = fixtureAgent({
  id: FIXTURE_AGENT_IDS.dataAnalyst,
  name: "Data analyst",
  description: "Digs through metrics and writes up what changed and why.",
  definition: {
    persona:
      "You are a careful data analyst. Answer with numbers, name your sources, and flag any metric you could not verify.",
    model: { preset: "powerful", reasoning: "high" },
    context: { mcpConnectionIds: [], skillIds: [] },
  },
  published: true,
  buildStatus: "failed",
});

export const FIXTURE_AGENTS: readonly FixtureAgent[] = [
  FIXTURE_EXEC_ASSISTANT,
  FIXTURE_SUPPORT_TRIAGER,
  FIXTURE_RELEASE_BOT,
  FIXTURE_DATA_ANALYST,
];

export function fixtureAgentById(id: string): FixtureAgent | undefined {
  return FIXTURE_AGENTS.find((entry) => entry.agent.id === id);
}
