/**
 * Workspace members: role chips + role changes (owners/admins) + invite by
 * email. Invitations go through Better Auth's organization plugin; when the
 * deployment has no mailer the created invitation link is surfaced to copy
 * so the inviter can share it directly.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Send } from "lucide-react";
import { useState } from "react";
import type { WorkspaceMemberDto } from "@invisible-string/shared";

import { authClient } from "../../lib/auth-client";
import { copyText } from "../../lib/clipboard";
import { isValidEmail } from "../../lib/validate";
import { queryKeys } from "../../lib/queries/keys";
import { useWorkspaceMembers } from "../../lib/queries/members";
import { Button } from "../ui/Button";
import { Chip, type ChipTone } from "../ui/Chip";
import { ErrorState } from "../ui/ErrorState";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { SkeletonList } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { SettingsSection } from "./SettingsSection";

export interface MembersPanelProps {
  workspaceId: string;
  canManage: boolean;
  currentUserId: string | undefined;
}

type InvitableRole = "admin" | "member";

const ROLE_TONE: Record<string, ChipTone> = {
  owner: "ink",
  admin: "neutral",
  member: "neutral",
};

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function primaryRole(role: string): string {
  return role.split(",")[0]?.trim() ?? role;
}

export function MembersPanel({ workspaceId, canManage, currentUserId }: MembersPanelProps) {
  const members = useWorkspaceMembers(workspaceId);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitableRole>("member");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [savingRoleFor, setSavingRoleFor] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function invalidateMembers() {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.members.list(workspaceId),
    });
  }

  async function sendInvite() {
    if (!isValidEmail(email.trim())) {
      setEmailError("Enter a valid email address.");
      return;
    }
    setInviting(true);
    setInviteLink(null);
    try {
      const result = await authClient.organization.inviteMember({
        email: email.trim(),
        role: inviteRole,
        organizationId: workspaceId,
      });
      const error = (result as { error: { message?: string } | null }).error;
      if (error) {
        toast({ variant: "error", message: error.message ?? "Could not send the invite." });
        return;
      }
      const data = (result as { data: { id?: string } | null }).data;
      const invitationId = data?.id;
      if (invitationId) {
        setInviteLink(`${window.location.origin}/accept-invitation/${invitationId}`);
      }
      setEmail("");
      setEmailError(null);
      toast({ variant: "success", message: `Invitation sent to ${email.trim()}.` });
      await invalidateMembers();
    } catch {
      toast({ variant: "error", message: "Could not send the invite." });
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(member: WorkspaceMemberDto, role: string) {
    setSavingRoleFor(member.id);
    try {
      const result = await authClient.organization.updateMemberRole({
        memberId: member.id,
        role: role as InvitableRole,
        organizationId: workspaceId,
      });
      const error = (result as { error: { message?: string } | null }).error;
      if (error) {
        toast({ variant: "error", message: error.message ?? "Could not update the role." });
        return;
      }
      toast({ variant: "success", message: `${member.email} is now ${role}.` });
      await invalidateMembers();
    } catch {
      toast({ variant: "error", message: "Could not update the role." });
    } finally {
      setSavingRoleFor(null);
    }
  }

  async function copyInvite() {
    if (!inviteLink) return;
    const ok = await copyText(inviteLink);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast({ variant: "error", message: "Couldn't copy — select and copy the link." });
    }
  }

  return (
    <SettingsSection
      title="Members"
      description="Who can access this workspace and what they can do."
    >
      {members.isPending ? (
        <SkeletonList rows={3} />
      ) : members.isError ? (
        <ErrorState
          compact
          message={members.error instanceof Error ? members.error.message : "Failed to load members."}
          onRetry={() => void members.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <ul className="flex flex-col gap-2">
            {members.data.map((member) => {
              const role = primaryRole(member.role);
              const isSelf = member.userId === currentUserId;
              const editable = canManage && !isSelf && role !== "owner";
              return (
                <li
                  key={member.id}
                  className="flex items-center gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 px-4 py-3"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-[13px] font-semibold text-ink-2">
                    {(member.name ?? member.email).charAt(0).toUpperCase()}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] font-semibold text-ink">
                      {member.name ?? member.email}
                      {isSelf ? <span className="font-normal text-ink-4"> · you</span> : null}
                    </span>
                    <span className="truncate text-[12.5px] text-ink-4">{member.email}</span>
                  </div>
                  {editable ? (
                    <div className="w-32 shrink-0">
                      <Select
                        aria-label={`Role for ${member.email}`}
                        value={role}
                        disabled={savingRoleFor === member.id}
                        onChange={(event) => void changeRole(member, event.currentTarget.value)}
                        options={[
                          { value: "admin", label: "Admin" },
                          { value: "member", label: "Member" },
                        ]}
                      />
                    </div>
                  ) : (
                    <Chip tone={ROLE_TONE[role] ?? "neutral"}>{roleLabel(role)}</Chip>
                  )}
                </li>
              );
            })}
          </ul>

          {canManage ? (
            <div className="flex flex-col gap-3 rounded-card-lg border border-black/[0.07] bg-white/40 p-4">
              <p className="text-[13px] font-semibold text-ink">Invite a teammate</p>
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Input
                    label="Email"
                    type="email"
                    value={email}
                    placeholder="teammate@company.com"
                    error={emailError}
                    onChange={(event) => {
                      setEmail(event.currentTarget.value);
                      if (emailError) setEmailError(null);
                    }}
                  />
                </div>
                <div className="sm:w-36">
                  <Select
                    label="Role"
                    value={inviteRole}
                    onChange={(event) =>
                      setInviteRole(event.currentTarget.value as InvitableRole)
                    }
                    options={[
                      { value: "member", label: "Member" },
                      { value: "admin", label: "Admin" },
                    ]}
                  />
                </div>
                <Button size="sm" className="h-10" loading={inviting} onClick={() => void sendInvite()}>
                  <Send size={14} aria-hidden="true" />
                  Invite
                </Button>
              </div>

              {inviteLink ? (
                <div className="flex flex-col gap-2 rounded-card border border-black/[0.07] bg-white/60 p-3">
                  <p className="text-[12.5px] text-ink-3">
                    No mailer configured — share this invite link directly.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-[8px] bg-black/[0.05] px-2.5 py-1.5 font-mono text-[12px] text-ink-2">
                      {inviteLink}
                    </code>
                    <Button variant="ghost" size="sm" onClick={() => void copyInvite()}>
                      {copied ? (
                        <>
                          <Check size={13} aria-hidden="true" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy size={13} aria-hidden="true" /> Copy
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </SettingsSection>
  );
}
