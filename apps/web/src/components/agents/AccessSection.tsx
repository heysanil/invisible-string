/**
 * ACCESS section: the run-as trust decision. The agent runs with one
 * member's connected credentials — in chat and in every workflow that
 * delegates to it (workflows no longer carry their own run-as).
 */
import { UserRound } from "lucide-react";
import type { WorkspaceMemberDto } from "@invisible-string/shared";

import { Select } from "../ui/Select";
import { StatusChip } from "../ui/StatusChip";

export interface AccessSectionProps {
  members: readonly WorkspaceMemberDto[];
  runAsUserId: string;
  onChangeRunAs: (userId: string) => void;
}

export function AccessSection({
  members,
  runAsUserId,
  onChangeRunAs,
}: AccessSectionProps) {
  const runAsMember = members.find((m) => m.userId === runAsUserId);

  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-black/[0.07] bg-white/40 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <UserRound size={15} className="text-ink-3" aria-hidden="true" />
        <h3 className="text-[13.5px] font-semibold text-ink">Run as</h3>
      </div>
      <p className="text-[12.5px] leading-relaxed text-ink-3">
        This agent runs with this member's connected credentials — in chat and
        in every workflow that delegates to it.
      </p>
      {members.length > 0 ? (
        <Select
          label="Run-as member"
          srOnlyLabel
          value={runAsUserId}
          options={members.map((member) => ({
            value: member.userId,
            label: member.name
              ? `${member.name} · ${member.email}`
              : member.email,
          }))}
          onChange={(event) => onChangeRunAs(event.currentTarget.value)}
        />
      ) : (
        <StatusChip tone="neutral">{runAsMember?.email ?? runAsUserId}</StatusChip>
      )}
    </div>
  );
}
