/**
 * Settings → Integrations: connect the platform Slack app, list connected
 * teams, and disconnect. The bot token is stored ENCRYPTED server-side and
 * never returned — a connected card shows only non-secret team metadata.
 *
 * Connecting is a full-page navigation to the control plane's install route
 * (which 302s to Slack consent); Slack redirects back to the callback, which
 * lands here with `?slack=connected`.
 */
import { useMemo, useState } from "react";
import { Hash, Plug, Trash2 } from "lucide-react";
import type { IntegrationDto } from "@invisible-string/shared";

import {
  slackInstallUrl,
  useDisconnectIntegration,
  useIntegrations,
} from "../../lib/queries/integrations";
import { errorMessage } from "../../lib/forms";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { SkeletonList } from "../ui/Skeleton";
import { StatusChip } from "../ui/StatusChip";
import { useToast } from "../ui/Toast";
import { SettingsSection } from "./SettingsSection";

export interface IntegrationsPanelProps {
  workspaceId: string;
  canManage: boolean;
}

export function IntegrationsPanel({ workspaceId, canManage }: IntegrationsPanelProps) {
  const integrations = useIntegrations(workspaceId);
  const disconnect = useDisconnectIntegration(workspaceId);
  const { toast } = useToast();
  const [pendingDisconnect, setPendingDisconnect] = useState<IntegrationDto | null>(null);

  // The OAuth callback lands back here with ?slack=connected|denied.
  const slackParam = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("slack");
  }, []);
  const banner =
    slackParam === "connected"
      ? { tone: "success" as const, text: "Slack connected." }
      : slackParam === "denied"
        ? { tone: "warning" as const, text: "Slack connection was cancelled." }
        : slackParam === "forbidden"
          ? {
              tone: "warning" as const,
              text: "Finish the Slack install signed in as an admin of the workspace that started it.",
            }
          : slackParam === "team_already_connected"
            ? {
                tone: "warning" as const,
                text: "That Slack team is already connected to another workspace here — disconnect it there first.",
              }
            : null;

  function connectSlack() {
    // Top-level navigation so the session cookie rides to the control plane.
    window.location.href = slackInstallUrl(workspaceId);
  }

  async function confirmDisconnect() {
    const target = pendingDisconnect;
    if (!target) return;
    try {
      await disconnect.mutateAsync(target.id);
      toast({ variant: "success", message: `Disconnected ${target.teamName ?? target.externalId}.` });
    } catch (error) {
      toast({ variant: "error", message: errorMessage(error, "Could not disconnect.") });
    } finally {
      setPendingDisconnect(null);
    }
  }

  const slackTeams = (integrations.data ?? []).filter((i) => i.type === "slack");

  return (
    <SettingsSection
      title="Integrations"
      description="Connect Slack so workflows can be triggered by mentions and reply in-thread."
      action={
        canManage ? (
          <Button size="sm" onClick={connectSlack}>
            <Hash size={14} aria-hidden="true" />
            Connect Slack
          </Button>
        ) : undefined
      }
    >
      {banner ? (
        <div className="mb-4">
          <StatusChip tone={banner.tone} dot>
            {banner.text}
          </StatusChip>
        </div>
      ) : null}

      {integrations.isPending ? (
        <SkeletonList rows={2} />
      ) : integrations.isError ? (
        <ErrorState
          compact
          message={errorMessage(integrations.error, "Failed to load integrations.")}
          onRetry={() => void integrations.refetch()}
        />
      ) : slackTeams.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No connected workspaces"
          description="Connect Slack to route mentions and DMs to your workflows. We store an encrypted bot token — never your Slack password."
          action={
            canManage ? (
              <Button size="sm" onClick={connectSlack}>
                <Hash size={14} aria-hidden="true" />
                Connect Slack
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {slackTeams.map((team) => (
            <li
              key={team.id}
              className="flex items-center gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 px-4 py-3"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-ink-2">
                <Hash size={16} aria-hidden="true" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13.5px] font-semibold text-ink">
                  {team.teamName ?? team.externalId}
                </span>
                <span className="truncate text-[12.5px] text-ink-4">
                  Team {team.externalId}
                  {team.scopes.length > 0 ? ` · ${team.scopes.length} scopes` : ""}
                </span>
              </div>
              <Chip tone="neutral">Connected</Chip>
              {canManage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Disconnect ${team.teamName ?? team.externalId}`}
                  onClick={() => setPendingDisconnect(team)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Disconnect
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title="Disconnect Slack?"
        description={
          pendingDisconnect
            ? `Workflows bound to ${pendingDisconnect.teamName ?? pendingDisconnect.externalId} will stop receiving Slack events.`
            : ""
        }
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
        onConfirm={() => void confirmDisconnect()}
        onClose={() => setPendingDisconnect(null)}
      />
    </SettingsSection>
  );
}
