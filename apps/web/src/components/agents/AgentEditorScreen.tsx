/**
 * The agent editor — the flagship screen. Three-part frame in the builder's
 * visual grammar (it encodes "durable thing with a draft→publish lifecycle",
 * and agents are now the thing that builds): header panel, left AgentRail
 * whose section cards anchor-scroll the center column, one scrolling Panel of
 * four sections (Persona · Model · Context · Access), and the copilot dock on
 * the agent surface.
 *
 * `AgentSections` is exported for the fixture editor, which drives the same
 * components over a local reducer without queries.
 */
import { useNavigate } from "@tanstack/react-router";
import { Cpu, FileText, Plug, UserRound } from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type {
  AgentDefinition,
  AgentDto,
  ModelAllowlistEntryDto,
  ModelPresetDto,
  WorkspaceMemberDto,
} from "@invisible-string/shared";

import { countAgentIssues, type AgentDiagnostics } from "../../lib/agents/diagnostics";
import {
  AGENT_SECTIONS,
  AGENT_SECTION_LABELS,
  type AgentEditorAction,
  type AgentEditorState,
  type AgentSection,
} from "../../lib/agents/model";
import {
  agentEditorStateFromAgent,
  useAgentController,
} from "../../lib/agents/useAgentController";
import type { ContextResources } from "../../lib/builder/resources";
import { agentCopilotAdapter } from "../../lib/copilot/agent-mutations";
import { useDeleteAgent, useUpdateAgent } from "../../lib/queries/agents";
import { errorMessage } from "../../lib/forms";
import { cn } from "../../lib/cn";
import { CopilotDock, type CopilotPrefill } from "../copilot/CopilotDock";
import { DiagnosticsList } from "../builder/DiagnosticsList";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Panel } from "../ui/Panel";
import { useToast } from "../ui/Toast";
import { AccessSection } from "./AccessSection";
import { ContextAttachments } from "../context/ContextAttachments";
import { AgentHeader } from "./AgentHeader";
import { ModelSection } from "./ModelSection";
import { PersonaSection } from "./PersonaSection";
import { AgentRail } from "./AgentRail";

export interface AgentEditorScreenProps {
  workspaceId: string;
  agent: AgentDto;
  resources: ContextResources;
  members: readonly WorkspaceMemberDto[];
  modelPresets: readonly ModelPresetDto[];
  /** Enabled allowlist entries; null while still loading. */
  allowlist: readonly ModelAllowlistEntryDto[] | null;
  /** Owner/admin — may delete the agent. */
  canManage: boolean;
}

export function AgentEditorScreen({
  workspaceId,
  agent,
  resources,
  members,
  modelPresets,
  allowlist,
  canManage,
}: AgentEditorScreenProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const updateAgent = useUpdateAgent(workspaceId);
  const deleteAgent = useDeleteAgent(workspaceId);

  const initialState = useMemo(
    () => agentEditorStateFromAgent(agent),
    // Seed once per mount (route keys this screen by agent.id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const controller = useAgentController({
    workspaceId,
    agent,
    initialState,
    allowlist,
  });
  const { state, dispatch, diagnostics } = controller;

  const [chatPending, setChatPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ── anchor scroll + aria-current ──────────────────────────────────────────

  const [activeSection, setActiveSection] = useState<AgentSection>("persona");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Partial<Record<AgentSection, HTMLElement | null>>>({});
  // While a card-driven smooth scroll is in flight, the scroll-sync handler
  // must not fight the selection.
  const scrollSyncMutedUntil = useRef(0);

  const registerSection = (section: AgentSection) => (el: HTMLElement | null) => {
    sectionRefs.current[section] = el;
  };

  function selectSection(section: AgentSection) {
    setActiveSection(section);
    scrollSyncMutedUntil.current = Date.now() + 800;
    const el = sectionRefs.current[section];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    }
  }

  function syncActiveSectionFromScroll() {
    if (Date.now() < scrollSyncMutedUntil.current) return;
    const container = scrollRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    let current: AgentSection = AGENT_SECTIONS[0]!;
    for (const section of AGENT_SECTIONS) {
      const el = sectionRefs.current[section];
      if (!el) continue;
      if (el.getBoundingClientRect().top - containerTop <= 96) current = section;
    }
    setActiveSection((prev) => (prev === current ? prev : current));
  }

  // ── copilot plumbing (prefill + applied-suggestion flash) ─────────────────

  const [copilotPrefill, setCopilotPrefill] = useState<CopilotPrefill | null>(null);
  const [flashSection, setFlashSection] = useState<AgentSection | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function askCopilot(text: string) {
    setCopilotPrefill((current) => ({ id: (current?.id ?? 0) + 1, text }));
  }

  function onSuggestionApplied(section: AgentSection) {
    setFlashSection(null);
    // Cancel BOTH timers: a stale clear-timer from the previous apply would
    // otherwise cut the new flash short mid-animation.
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (flashClearTimer.current) clearTimeout(flashClearTimer.current);
    // Re-arm on the next frame so consecutive applies re-trigger the animation.
    flashTimer.current = setTimeout(() => setFlashSection(section), 16);
    flashClearTimer.current = setTimeout(
      () => setFlashSection((s) => (s === section ? null : s)),
      900,
    );
  }

  // The adapter reads the LIVE draft through a ref — never a stale capture.
  const draftRef = useRef<AgentDefinition>(state.definition);
  draftRef.current = state.definition;
  const adapter = agentCopilotAdapter({
    agentId: agent.id,
    getDraft: () => draftRef.current,
    dispatch,
    resources,
    onApplied: onSuggestionApplied,
  });

  // ── header + rail actions ─────────────────────────────────────────────────

  async function commitName(next: string): Promise<boolean> {
    try {
      await updateAgent.mutateAsync({ agentId: agent.id, patch: { name: next } });
      return true;
    } catch (error) {
      toast({ variant: "error", message: errorMessage(error) });
      return false;
    }
  }

  async function onPublish() {
    const response = await controller.publish();
    if (response && response.buildStatus === "succeeded") {
      toast({
        variant: "success",
        message: response.cached
          ? "Published — served from build cache."
          : "Published and built.",
      });
    }
  }

  async function onChatWithAgent() {
    setChatPending(true);
    try {
      // A dirty draft (or a never-published agent) publishes first — chat
      // always talks to a ready build.
      if (controller.isDirty || agent.publishedVersionId === null) {
        const response = await controller.publish();
        if (!response) return; // publish surfaced its own error
        if (response.buildStatus !== "succeeded") {
          toast({
            variant: "error",
            message: "The agent must build cleanly before you can chat with it.",
          });
          return;
        }
      }
      navigate({ to: "/chat", search: { agent: agent.id } });
    } finally {
      setChatPending(false);
    }
  }

  function onDelete() {
    deleteAgent.mutate(agent.id, {
      onSuccess: () => {
        toast({ variant: "success", message: "Agent deleted." });
        navigate({ to: "/agents" });
      },
      onError: (error) => {
        setConfirmDelete(false);
        toast({ variant: "error", message: errorMessage(error) });
      },
    });
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <AgentHeader
        name={agent.name}
        onCommitName={commitName}
        saveStatus={controller.saveStatus}
        issueCount={countAgentIssues(diagnostics)}
        isDirty={controller.isDirty}
        onRequestDelete={canManage ? () => setConfirmDelete(true) : undefined}
      />

      <div className="flex min-h-0 flex-1 gap-4">
        <AgentRail
          name={agent.name}
          publishedVersionId={agent.publishedVersionId}
          isDirty={controller.isDirty}
          state={state}
          diagnostics={diagnostics}
          activeSection={activeSection}
          onSelectSection={selectSection}
          resources={resources}
          members={members}
          modelPresets={modelPresets}
          publishState={controller.publishState}
          onPublish={onPublish}
          canPublish={controller.canPublish}
          onChatWithAgent={onChatWithAgent}
          chatPending={chatPending}
          flashSection={flashSection}
        />

        <Panel className="panel-enter flex min-w-0 flex-1 flex-col overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={syncActiveSectionFromScroll}
            className="thin-scroll flex-1 overflow-y-auto p-6"
          >
            <div className="mx-auto flex max-w-2xl flex-col">
              <AgentSections
                workspaceId={workspaceId}
                state={state}
                dispatch={dispatch}
                diagnostics={diagnostics}
                resources={resources}
                members={members}
                modelPresets={modelPresets}
                allowlist={allowlist ?? []}
                registerSection={registerSection}
                onAskCopilot={askCopilot}
              />
            </div>
          </div>
        </Panel>

        <CopilotDock
          workspaceId={workspaceId}
          adapter={adapter}
          prefill={copilotPrefill}
        />
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        title={`Delete ${agent.name}?`}
        description="Workflows delegating to this agent will stop publishing, and its chat history keeps the name for provenance. This cannot be undone."
        confirmLabel="Delete agent"
        destructive
        loading={deleteAgent.isPending}
      />
    </div>
  );
}

// ── Center column sections ──────────────────────────────────────────────────

const SECTION_ICONS: Record<AgentSection, ComponentType<{ size?: number }>> = {
  persona: FileText,
  model: Cpu,
  context: Plug,
  access: UserRound,
};

const SECTION_HINTS: Record<AgentSection, string> = {
  persona: "Who this agent is",
  model: "How it thinks",
  context: "Tools and knowledge",
  access: "Whose credentials it uses",
};

export interface AgentSectionsProps {
  workspaceId: string;
  state: AgentEditorState;
  dispatch: (action: AgentEditorAction) => void;
  diagnostics: AgentDiagnostics;
  resources: ContextResources;
  members: readonly WorkspaceMemberDto[];
  modelPresets: readonly ModelPresetDto[];
  allowlist: readonly ModelAllowlistEntryDto[];
  /** Ref-callback factory so the owner can anchor-scroll to each section. */
  registerSection: (section: AgentSection) => (el: HTMLElement | null) => void;
  onAskCopilot?: (prompt: string) => void;
}

export function AgentSections({
  workspaceId,
  state,
  dispatch,
  diagnostics,
  resources,
  members,
  modelPresets,
  allowlist,
  registerSection,
  onAskCopilot,
}: AgentSectionsProps) {
  const bodies: Record<AgentSection, ReactNode> = {
    persona: (
      <PersonaSection
        description={state.description}
        persona={state.definition.persona}
        onChangeDescription={(description) =>
          dispatch({ type: "setDescription", description })
        }
        onChangePersona={(markdown) => dispatch({ type: "setPersona", markdown })}
      />
    ),
    model: (
      <ModelSection
        model={state.definition.model}
        dispatch={dispatch}
        modelPresets={modelPresets}
        allowlist={allowlist}
      />
    ),
    context: (
      <ContextAttachments
        workspaceId={workspaceId}
        connectionIds={state.definition.context.mcpConnectionIds}
        skillIds={state.definition.context.skillIds}
        onAddConnection={(id) => dispatch({ type: "addConnection", id })}
        onRemoveConnection={(id) => dispatch({ type: "removeConnection", id })}
        onAddSkill={(id) => dispatch({ type: "addSkill", id })}
        onRemoveSkill={(id) => dispatch({ type: "removeSkill", id })}
        resources={resources}
      />
    ),
    access: (
      <AccessSection
        members={members}
        runAsUserId={state.runAsUserId}
        onChangeRunAs={(userId) => dispatch({ type: "setRunAs", userId })}
      />
    ),
  };

  return (
    <div className="flex flex-col">
      {diagnostics.general.length > 0 ? (
        <div className="pb-6">
          <DiagnosticsList
            diagnostics={diagnostics.general}
            onAskCopilot={onAskCopilot}
          />
        </div>
      ) : null}

      {AGENT_SECTIONS.map((section, index) => {
        const Icon = SECTION_ICONS[section];
        return (
          <div key={section} className="flex flex-col">
            {index > 0 ? (
              <div aria-hidden="true" className="my-8 h-px bg-black/[0.06]" />
            ) : null}
            <section
              ref={registerSection(section)}
              aria-labelledby={`agent-section-${section}`}
              className={cn("flex scroll-mt-6 flex-col gap-4")}
            >
              <header className="flex items-baseline justify-between">
                <h2
                  id={`agent-section-${section}`}
                  className="flex items-center gap-2 text-[16px]"
                >
                  <Icon size={15} aria-hidden="true" />
                  {AGENT_SECTION_LABELS[section]}
                </h2>
                <span className="text-[12px] text-ink-4">
                  {SECTION_HINTS[section]}
                </span>
              </header>
              <DiagnosticsList
                diagnostics={diagnostics.sections[section]}
                onAskCopilot={onAskCopilot}
              />
              {bodies[section]}
            </section>
          </div>
        );
      })}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
