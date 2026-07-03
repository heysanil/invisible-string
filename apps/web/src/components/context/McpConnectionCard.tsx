import { Blocks, Globe, ShieldCheck, Trash2 } from "lucide-react";
import type { McpConnectionDto } from "@invisible-string/shared";

import { APPROVAL_LABEL } from "../../lib/labels";
import { Chip } from "../ui/Chip";
import { Switch } from "../ui/Switch";

export interface McpConnectionCardProps {
  connection: McpConnectionDto;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  /** Members (read-only) get no mutating controls. */
  readOnly?: boolean;
}

/** Human summary of the tool filter (allow/block/all). */
function toolsLabel(connection: McpConnectionDto): string {
  if (connection.toolAllow && connection.toolAllow.length > 0) {
    const n = connection.toolAllow.length;
    return `${n} tool${n === 1 ? "" : "s"}`;
  }
  if (connection.toolBlock && connection.toolBlock.length > 0) {
    const n = connection.toolBlock.length;
    return `All except ${n}`;
  }
  return "All tools";
}

export function McpConnectionCard({
  connection,
  onToggle,
  onDelete,
  readOnly = false,
}: McpConnectionCardProps) {
  const approval = connection.approvalPolicy?.default ?? "never";
  const customApprovals = connection.approvalPolicy?.tools
    ? Object.keys(connection.approvalPolicy.tools).length
    : 0;
  const SourceIcon = connection.source === "custom" ? Globe : Blocks;

  return (
    <div className="lift flex flex-col gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-black/[0.05] text-ink-2">
          <SourceIcon size={17} strokeWidth={1.9} aria-hidden="true" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[14px] font-semibold text-ink" title={connection.name}>
              {connection.name}
            </h3>
            {connection.hasCredentials ? (
              <span title="Credentials stored" className="text-ink-3">
                <ShieldCheck size={14} aria-label="Credentials stored" />
              </span>
            ) : null}
          </div>
          <p className="truncate text-[12px] text-ink-4">
            {connection.source === "registry"
              ? (connection.registryId ?? "Registry server")
              : (connection.url ?? "Custom server")}
          </p>
        </div>
        {readOnly ? null : (
          <Switch
            checked={connection.enabled}
            onChange={onToggle}
            label={`${connection.enabled ? "Disable" : "Enable"} ${connection.name}`}
          />
        )}
      </div>

      {connection.description ? (
        <p className="line-clamp-2 text-[12.5px] leading-relaxed text-ink-3">
          {connection.description}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="neutral">{toolsLabel(connection)}</Chip>
        <Chip tone={approval === "never" ? "neutral" : "warn"} dot={approval !== "never"}>
          {APPROVAL_LABEL[approval]}
          {customApprovals > 0 ? ` · +${customApprovals}` : ""}
        </Chip>
        {connection.enabled ? null : <Chip tone="neutral">Disabled</Chip>}
      </div>

      {readOnly ? null : (
        <div className="mt-0.5 flex items-center justify-end border-t border-black/[0.05] pt-2.5">
          <button
            type="button"
            onClick={onDelete}
            className="lift inline-flex items-center gap-1.5 rounded-capsule px-2.5 py-1.5 text-[12.5px] font-medium text-ink-3 hover:bg-err/10 hover:text-err"
          >
            <Trash2 size={13} aria-hidden="true" />
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
