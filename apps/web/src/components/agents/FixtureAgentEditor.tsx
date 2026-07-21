/**
 * Fixture-mode agent editor (VITE_FIXTURE_MODE=1): the REAL editor components
 * (header, rail, sections) over a local reducer — no queries, no autosave, no
 * copilot socket. Publish simulates the staged build progression so the
 * rail's compiling → building → ready/error treatment is reviewable; the
 * "Data analyst" fixture (published build FAILED) lands on the error card.
 */
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, ArrowLeft } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type {
  ModelAllowlistEntryDto,
  ModelPresetDto,
  PublishAgentResponse,
} from "@invisible-string/shared";

import {
  countAgentIssues,
  localAgentDiagnostics,
} from "../../lib/agents/diagnostics";
import {
  FIXTURE_AGENT_CONNECTIONS,
  FIXTURE_AGENT_SKILLS,
  FIXTURE_BUILD_ERROR,
  FIXTURE_MEMBERS,
  fixtureAgentById,
  type FixtureAgent,
} from "../../lib/agents/fixtures";
import {
  agentEditorReducer,
  initAgentEditorState,
  type AgentSection,
} from "../../lib/agents/model";
import {
  INITIAL_PUBLISH_STATE,
  publishReducer,
} from "../../lib/agents/publish-machine";
import type { ContextResources } from "../../lib/builder/resources";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { AgentSections } from "./AgentEditorScreen";
import { AgentHeader } from "./AgentHeader";
import { AgentRail } from "./AgentRail";

const FIXTURE_WORKSPACE_ID = "org_fixture";

const NOW = "2026-07-09T09:00:00.000Z";

const FIXTURE_MODEL_PRESETS: readonly ModelPresetDto[] = [
  { id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", slug: "powerful", provider: "openrouter", modelId: "z-ai/glm-5.2", createdAt: NOW, updatedAt: NOW },
  { id: "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa", slug: "balanced", provider: "openrouter", modelId: "deepseek/deepseek-v4-pro", createdAt: NOW, updatedAt: NOW },
  { id: "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa", slug: "quick", provider: "openrouter", modelId: "deepseek/deepseek-v4-flash", createdAt: NOW, updatedAt: NOW },
];

const FIXTURE_ALLOWLIST: readonly ModelAllowlistEntryDto[] =
  FIXTURE_MODEL_PRESETS.map((preset, index) => ({
    id: `bbbbbbbb-000${index + 1}-4000-8000-bbbbbbbbbbbb`,
    provider: preset.provider,
    modelId: preset.modelId,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  }));

const FIXTURE_RESOURCES: ContextResources = (() => {
  const connections = FIXTURE_AGENT_CONNECTIONS.map((connection) => ({
    ...connection,
    resourceScope: "workspace" as const,
  }));
  const skills = FIXTURE_AGENT_SKILLS.map((skill) => ({
    ...skill,
    resourceScope: "workspace" as const,
  }));
  return {
    connections,
    skills,
    connectionById: new Map(connections.map((c) => [c.id, c])),
    skillById: new Map(skills.map((s) => [s.id, s])),
    isPending: false,
    isError: false,
  };
})();

export function FixtureAgentEditor({ agentId }: { agentId: string }) {
  const fixture = fixtureAgentById(agentId);
  if (!fixture) {
    return (
      <Panel className="panel-enter flex h-full items-center justify-center">
        <EmptyState
          icon={CircleAlert}
          title="Agent not found"
          description="This fixture id doesn't exist. Head back to the list to pick one."
          action={
            <Link
              to="/agents"
              className="lift inline-flex items-center gap-1.5 rounded-capsule border border-black/10 bg-white/50 px-4 py-2 text-[13px] font-medium text-ink"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back to agents
            </Link>
          }
        />
      </Panel>
    );
  }
  return <FixtureEditor key={fixture.agent.id} fixture={fixture} />;
}

function FixtureEditor({ fixture }: { fixture: FixtureAgent }) {
  const navigate = useNavigate();
  const [name, setName] = useState(fixture.agent.name);
  const [state, dispatch] = useReducer(
    agentEditorReducer,
    fixture.agent,
    initAgentEditorState,
  );
  const [publishState, publishDispatch] = useReducer(
    publishReducer,
    INITIAL_PUBLISH_STATE,
  );
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const diagnostics = localAgentDiagnostics({
    definition: state.definition,
    allowedModelIds: FIXTURE_ALLOWLIST.map((entry) => entry.modelId),
  });

  // ── anchor scroll + aria-current (mirrors the live screen) ───────────────

  const [activeSection, setActiveSection] = useState<AgentSection>("persona");
  const sectionRefs = useRef<Partial<Record<AgentSection, HTMLElement | null>>>({});
  const registerSection = (section: AgentSection) => (el: HTMLElement | null) => {
    sectionRefs.current[section] = el;
  };
  function selectSection(section: AgentSection) {
    setActiveSection(section);
    const el = sectionRefs.current[section];
    if (el && typeof el.scrollIntoView === "function") {
      const reduced =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
  }

  // ── simulated publish (staged progression, no backend) ───────────────────

  function simulatePublish() {
    const fails = fixture.summary.buildStatus === "failed";
    const base: PublishAgentResponse = {
      agentId: fixture.agent.id,
      versionId: fixture.summary.publishedVersionId ?? fixture.agent.id,
      contentHash: "fixture-hash",
      buildStatus: "building",
      cached: false,
      buildError: null,
    };
    publishDispatch({ type: "start" });
    timers.current.push(
      setTimeout(
        () => publishDispatch({ type: "received", response: base }),
        450,
      ),
      setTimeout(
        () =>
          publishDispatch({
            type: "received",
            response: fails
              ? { ...base, buildStatus: "failed", buildError: FIXTURE_BUILD_ERROR }
              : { ...base, buildStatus: "succeeded" },
          }),
        1400,
      ),
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <AgentHeader
        name={name}
        onCommitName={(next) => {
          setName(next);
          return true;
        }}
        saveStatus="saved"
        issueCount={countAgentIssues(diagnostics)}
        isDirty={false}
        onRequestDelete={undefined}
      />

      <div className="flex min-h-0 flex-1 gap-4">
        <AgentRail
          name={name}
          publishedVersionId={fixture.agent.publishedVersionId}
          isDirty={false}
          state={state}
          diagnostics={diagnostics}
          activeSection={activeSection}
          onSelectSection={selectSection}
          resources={FIXTURE_RESOURCES}
          members={FIXTURE_MEMBERS}
          modelPresets={FIXTURE_MODEL_PRESETS}
          publishState={publishState}
          onPublish={simulatePublish}
          canPublish={state.definition.persona.trim().length > 0}
          onChatWithAgent={() =>
            navigate({ to: "/chat", search: { agent: fixture.agent.id } })
          }
          chatPending={false}
        />

        <Panel className="panel-enter flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="thin-scroll flex-1 overflow-y-auto p-6">
            <div className="mx-auto flex max-w-2xl flex-col">
              <AgentSections
                workspaceId={FIXTURE_WORKSPACE_ID}
                state={state}
                dispatch={dispatch}
                diagnostics={diagnostics}
                resources={FIXTURE_RESOURCES}
                members={FIXTURE_MEMBERS}
                modelPresets={FIXTURE_MODEL_PRESETS}
                allowlist={FIXTURE_ALLOWLIST}
                registerSection={registerSection}
              />
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
