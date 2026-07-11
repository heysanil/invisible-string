/**
 * Context attachments: two columns (connections · skills) over a plain
 * attached-ids + callbacks contract, so any owner of a context list (today:
 * the agent editor's CONTEXT section) can embed it. Attached resources render
 * as removable rows; "Browse" opens a searchable picker of workspace + user
 * resources. Each attached connection has an inline settings popover (tool
 * allow/block tag inputs + approval policy) that mutates the connection
 * resource itself.
 */
import { Blocks, ExternalLink, FileText, Plug, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type {
  McpApprovalDecision,
  UpdateMcpConnectionRequest,
} from "@invisible-string/shared";

import {
  scopeRefOf,
  type ContextResources,
  type ScopedConnection,
  type ScopedSkill,
} from "../../lib/builder/resources";
import { useUpdateMcpConnection } from "../../lib/queries/mcp-connections";
import { cn } from "../../lib/cn";

// Satisfies React's controlled-input contract; the real handler rides
// onInput, matching the shared Input primitive (React's onChange for text
// inputs never fires under happy-dom).
function noopChange() {}
import { Button } from "../ui/Button";
import { Popover } from "../ui/Popover";
import { Select } from "../ui/Select";
import { StatusChip } from "../ui/StatusChip";
import { TagInput } from "../ui/TagInput";
import { useToast } from "../ui/Toast";

export interface ContextAttachmentsProps {
  workspaceId: string;
  /** Attached MCP connection ids, in attachment order. */
  connectionIds: readonly string[];
  /** Attached skill ids, in attachment order. */
  skillIds: readonly string[];
  onAddConnection: (id: string) => void;
  onRemoveConnection: (id: string) => void;
  onAddSkill: (id: string) => void;
  onRemoveSkill: (id: string) => void;
  /** Merged workspace + user resources (resolves ids to rows). */
  resources: ContextResources;
}

export function ContextAttachments({
  workspaceId,
  connectionIds,
  skillIds,
  onAddConnection,
  onRemoveConnection,
  onAddSkill,
  onRemoveSkill,
  resources,
}: ContextAttachmentsProps) {
  const attachedConnectionIds = new Set(connectionIds);
  const attachedSkillIds = new Set(skillIds);

  const attachedConnections = connectionIds
    .map((id) => resources.connectionById.get(id))
    .filter((c): c is ScopedConnection => c !== undefined);
  const attachedSkills = skillIds
    .map((id) => resources.skillById.get(id))
    .filter((s): s is ScopedSkill => s !== undefined);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Connections column */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between px-0.5">
            <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
              <Plug size={14} aria-hidden="true" /> Connections
            </h3>
            <ResourcePicker
              kind="connection"
              title="Add a connection"
              options={resources.connections}
              attachedIds={attachedConnectionIds}
              onPick={onAddConnection}
            />
          </div>
          {attachedConnections.length === 0 ? (
            <EmptyColumn hint="No connections attached. Browse to add MCP servers this agent can use." />
          ) : (
            <ul className="flex flex-col gap-2">
              {attachedConnections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  workspaceId={workspaceId}
                  connection={connection}
                  onRemove={() => onRemoveConnection(connection.id)}
                />
              ))}
            </ul>
          )}
          {connectionIds.length > attachedConnections.length ? (
            <MissingNote
              count={connectionIds.length - attachedConnections.length}
              kind="connection"
            />
          ) : null}
        </section>

        {/* Skills column */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between px-0.5">
            <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
              <FileText size={14} aria-hidden="true" /> Skills
            </h3>
            <ResourcePicker
              kind="skill"
              title="Add a skill"
              options={resources.skills}
              attachedIds={attachedSkillIds}
              onPick={onAddSkill}
            />
          </div>
          {attachedSkills.length === 0 ? (
            <EmptyColumn hint="No skills attached. Browse to add authored skills." />
          ) : (
            <ul className="flex flex-col gap-2">
              {attachedSkills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  onRemove={() => onRemoveSkill(skill.id)}
                />
              ))}
            </ul>
          )}
          {skillIds.length > attachedSkills.length ? (
            <MissingNote
              count={skillIds.length - attachedSkills.length}
              kind="skill"
            />
          ) : null}
        </section>
      </div>

      <Link
        to="/context"
        className="lift inline-flex w-fit items-center gap-1.5 rounded-capsule border border-black/10 bg-white/40 px-3.5 py-1.5 text-[12.5px] font-medium text-ink-2 hover:border-black/20 hover:text-ink"
      >
        <Blocks size={14} aria-hidden="true" />
        Manage the full registry in Context
        <ExternalLink size={12} aria-hidden="true" />
      </Link>
    </div>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

function ScopeTag({ scope }: { scope: "workspace" | "user" }) {
  return (
    <StatusChip tone="neutral">
      {scope === "user" ? "Personal" : "Workspace"}
    </StatusChip>
  );
}

function ConnectionRow({
  workspaceId,
  connection,
  onRemove,
}: {
  workspaceId: string;
  connection: ScopedConnection;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-card border border-black/10 bg-white/45 py-2 pl-3 pr-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink">
            {connection.name}
          </span>
          <ScopeTag scope={connection.resourceScope} />
          {!connection.enabled ? (
            <StatusChip tone="warning">Disabled</StatusChip>
          ) : null}
        </div>
        {connection.description ? (
          <span className="truncate text-[12px] text-ink-3">
            {connection.description}
          </span>
        ) : null}
      </div>
      <ConnectionSettings workspaceId={workspaceId} connection={connection} />
      <RemoveButton label={`Remove ${connection.name}`} onClick={onRemove} />
    </li>
  );
}

function SkillRow({
  skill,
  onRemove,
}: {
  skill: ScopedSkill;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-card border border-black/10 bg-white/45 py-2 pl-3 pr-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink">
            {skill.name}
          </span>
          <ScopeTag scope={skill.resourceScope} />
          {skill.files.length > 0 ? (
            <StatusChip tone="neutral">
              {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
            </StatusChip>
          ) : null}
        </div>
        {skill.description ? (
          <span className="truncate text-[12px] text-ink-3">
            {skill.description}
          </span>
        ) : null}
      </div>
      <RemoveButton label={`Remove ${skill.name}`} onClick={onRemove} />
    </li>
  );
}

// ── Per-connection settings popover ─────────────────────────────────────────

const APPROVAL_OPTIONS: { value: McpApprovalDecision; label: string }[] = [
  { value: "never", label: "Never — auto-allow" },
  { value: "once", label: "Once per session" },
  { value: "always", label: "Always ask" },
];

type FilterMode = "none" | "allow" | "block";

function ConnectionSettings({
  workspaceId,
  connection,
}: {
  workspaceId: string;
  connection: ScopedConnection;
}) {
  const { toast } = useToast();
  const scopeRef = scopeRefOf(connection.resourceScope, workspaceId);
  const update = useUpdateMcpConnection(scopeRef);

  const initialMode: FilterMode =
    connection.toolAllow && connection.toolAllow.length > 0
      ? "allow"
      : connection.toolBlock && connection.toolBlock.length > 0
        ? "block"
        : "none";
  const [mode, setMode] = useState<FilterMode>(initialMode);
  const [tools, setTools] = useState<string[]>(
    initialMode === "allow"
      ? (connection.toolAllow ?? [])
      : initialMode === "block"
        ? (connection.toolBlock ?? [])
        : [],
  );
  const approval = connection.approvalPolicy?.default ?? "never";

  function persist(patch: UpdateMcpConnectionRequest) {
    update.mutate(
      { connectionId: connection.id, patch },
      {
        onError: () =>
          toast({ variant: "error", message: "Could not save connection settings." }),
      },
    );
  }

  function saveFilter(nextMode: FilterMode, nextTools: string[]) {
    setMode(nextMode);
    setTools(nextTools);
    persist({
      toolAllow: nextMode === "allow" ? (nextTools.length ? nextTools : null) : null,
      toolBlock: nextMode === "block" ? (nextTools.length ? nextTools : null) : null,
    });
  }

  return (
    <Popover
      label={`${connection.name} settings`}
      align="end"
      className="w-80"
      trigger={
        <Button variant="quiet" size="sm" aria-label={`${connection.name} settings`}>
          Settings
        </Button>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <span className="px-1 text-[12px] font-medium text-ink-2">
            Tool filter
          </span>
          <div className="flex gap-1.5">
            {(["none", "allow", "block"] as FilterMode[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => saveFilter(option, option === mode ? tools : [])}
                className={cn(
                  "lift flex-1 rounded-capsule border px-2 py-1 text-[12px] font-medium capitalize",
                  option === mode
                    ? "border-ink bg-ink text-white"
                    : "border-black/10 text-ink-3 hover:text-ink",
                )}
              >
                {option === "none" ? "All tools" : option}
              </button>
            ))}
          </div>
        </div>

        {mode !== "none" ? (
          <TagInput
            label={mode === "allow" ? "Allowed tools" : "Blocked tools"}
            values={tools}
            placeholder="tool name, then Enter"
            onChange={(next) => saveFilter(mode, next)}
          />
        ) : null}

        <Select
          label="Approval policy"
          value={approval}
          options={APPROVAL_OPTIONS}
          onChange={(event) =>
            persist({
              approvalPolicy: {
                ...(connection.approvalPolicy ?? {}),
                default: event.currentTarget.value as McpApprovalDecision,
              },
            })
          }
        />

        <p className="px-0.5 text-[11.5px] leading-snug text-ink-4">
          These settings live on the connection and apply everywhere it's used.
        </p>
      </div>
    </Popover>
  );
}

// ── Resource picker ─────────────────────────────────────────────────────────

interface PickerOption {
  id: string;
  name: string;
  description: string | null;
  resourceScope: "workspace" | "user";
}

function ResourcePicker({
  kind,
  title,
  options,
  attachedIds,
  onPick,
}: {
  kind: "connection" | "skill";
  title: string;
  options: readonly PickerOption[];
  attachedIds: Set<string>;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((option) => {
      if (attachedIds.has(option.id)) return false;
      if (q === "") return true;
      return (
        option.name.toLowerCase().includes(q) ||
        (option.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [options, attachedIds, query]);

  return (
    <Popover
      label={title}
      align="end"
      className="w-72"
      trigger={
        <Button variant="ghost" size="sm">
          <Plus size={14} aria-hidden="true" />
          Browse
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 rounded-capsule border border-black/10 bg-white/60 px-3">
          <Search size={14} className="text-ink-4" aria-hidden="true" />
          <input
            value={query}
            autoFocus
            onChange={noopChange}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            placeholder={`Search ${kind}s`}
            aria-label={`Search ${kind}s`}
            className="h-8 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
          />
        </div>
        <ul className="thin-scroll flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {available.length === 0 ? (
            <li className="px-2 py-6 text-center text-[12.5px] text-ink-4">
              {options.length === 0
                ? `No ${kind}s in this workspace yet.`
                : "Nothing matches."}
            </li>
          ) : (
            available.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => onPick(option.id)}
                  className="lift flex w-full flex-col gap-0.5 rounded-card px-2.5 py-2 text-left hover:bg-black/[0.04]"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {option.name}
                    </span>
                    <ScopeTag scope={option.resourceScope} />
                  </span>
                  {option.description ? (
                    <span className="line-clamp-2 text-[11.5px] text-ink-3">
                      {option.description}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </Popover>
  );
}

// ── bits ────────────────────────────────────────────────────────────────────

function EmptyColumn({ hint }: { hint: string }) {
  return (
    <p className="rounded-card border border-dashed border-black/15 px-4 py-6 text-center text-[12.5px] text-ink-4">
      {hint}
    </p>
  );
}

function MissingNote({
  count,
  kind,
}: {
  count: number;
  kind: "connection" | "skill";
}) {
  return (
    <p className="px-1 text-[12px] text-warn">
      {count} attached {kind}
      {count === 1 ? "" : "s"} could not be found — they may have been deleted.
    </p>
  );
}

function RemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="lift flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-err/10 hover:text-err"
    >
      <X size={15} aria-hidden="true" />
    </button>
  );
}
