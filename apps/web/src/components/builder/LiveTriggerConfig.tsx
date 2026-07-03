/**
 * Live trigger configuration (Phase 3): the parts of a TRIGGER pillar that
 * talk to the server, rendered under the draft-only {@link TriggerEditor}.
 *
 * - webhook/form: mint (once) / rotate the ingress token. The PLAINTEXT token
 *   is shown a SINGLE time in a copy-to-reveal card with "we store only a
 *   hash" — after that only its last-4 suffix is ever displayed.
 * - slack: point the trigger at a connected Slack team (Settings → Integrations
 *   is where teams are connected). The channel + mention rules live in the
 *   draft editor above; binding here persists the (team, rules) to the trigger.
 */
import { useState } from "react";
import { Check, Copy, KeyRound, Link2, RefreshCw } from "lucide-react";
import type {
  CreateWebhookTokenResponse,
  SlackTriggerBinding,
  TriggerBindingDto,
} from "@invisible-string/shared";

import { copyText } from "../../lib/clipboard";
import { errorMessage } from "../../lib/forms";
import {
  useBindSlackTrigger,
  useIntegrations,
  useMintWebhookToken,
  useTriggers,
} from "../../lib/queries/integrations";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { StatusChip } from "../ui/StatusChip";
import { useToast } from "../ui/Toast";

export interface LiveTriggerConfigProps {
  workspaceId: string;
  workflowId: string;
  triggerType: "webhook" | "form" | "slack";
  /** The draft's Slack routing rules (persisted on bind). */
  slackBinding?: SlackTriggerBinding;
}

export function LiveTriggerConfig({
  workspaceId,
  workflowId,
  triggerType,
  slackBinding,
}: LiveTriggerConfigProps) {
  const triggers = useTriggers(workspaceId, workflowId);
  const current = triggers.data?.find((t) => t.type === triggerType) ?? null;

  if (triggerType === "slack") {
    return (
      <SlackBinding
        workspaceId={workspaceId}
        workflowId={workflowId}
        current={current}
        binding={slackBinding ?? { mentionOnly: true, includeDirectMessages: false }}
      />
    );
  }
  return (
    <WebhookToken workspaceId={workspaceId} workflowId={workflowId} current={current} />
  );
}

// ── webhook/form token reveal ────────────────────────────────────────────────

function WebhookToken({
  workspaceId,
  workflowId,
  current,
}: {
  workspaceId: string;
  workflowId: string;
  current: TriggerBindingDto | null;
}) {
  const mint = useMintWebhookToken(workspaceId, workflowId);
  const { toast } = useToast();
  const [revealed, setRevealed] = useState<CreateWebhookTokenResponse | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    try {
      const result = await mint.mutateAsync(current?.hasToken ? current.id : undefined);
      setRevealed(result);
      setCopied(false);
    } catch (error) {
      toast({ variant: "error", message: errorMessage(error, "Could not mint a token.") });
    }
  }

  async function copy() {
    if (!revealed) return;
    if (await copyText(revealed.token)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast({ variant: "error", message: "Couldn't copy — select and copy the token." });
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-card border border-black/[0.07] bg-white/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound size={15} className="text-ink-3" aria-hidden="true" />
          <h3 className="text-[13.5px] font-semibold text-ink">Ingress token</h3>
        </div>
        <Button
          size="sm"
          variant={current?.hasToken ? "ghost" : "primary"}
          loading={mint.isPending}
          onClick={() => void generate()}
        >
          {current?.hasToken ? (
            <>
              <RefreshCw size={13} aria-hidden="true" /> Rotate token
            </>
          ) : (
            "Generate token"
          )}
        </Button>
      </div>

      {revealed ? (
        <div className="flex flex-col gap-2 rounded-card border border-amber-400/40 bg-amber-50/60 p-3">
          <p className="text-[12.5px] font-medium text-ink-2">
            Copy this now — we store only a hash, so it won’t be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code
              data-testid="revealed-token"
              className="min-w-0 flex-1 truncate rounded-[8px] bg-black/[0.06] px-2.5 py-1.5 font-mono text-[12px] text-ink-2"
            >
              {revealed.token}
            </code>
            <Button variant="ghost" size="sm" onClick={() => void copy()}>
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
          <div className="flex items-center gap-1.5 text-[12px] text-ink-4">
            <Link2 size={12} aria-hidden="true" />
            <span className="truncate">{revealed.ingressUrl}</span>
          </div>
        </div>
      ) : current?.hasToken ? (
        <div className="flex items-center gap-2">
          <StatusChip tone="success" dot>
            Active
          </StatusChip>
          <p className="text-[12.5px] text-ink-3">
            A token ending <code className="mono-chip">…{current.tokenSuffix}</code> is
            live. Only its hash is stored — rotate to issue a fresh one.
          </p>
        </div>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          Generate a secret webhook URL. POST a JSON payload to it and every field is
          addressable as <code className="mono-chip">@trigger.&lt;key&gt;</code> in your
          instructions. The token is shown once and stored only as a hash.
        </p>
      )}
    </section>
  );
}

// ── Slack team binding ───────────────────────────────────────────────────────

function SlackBinding({
  workspaceId,
  workflowId,
  current,
  binding,
}: {
  workspaceId: string;
  workflowId: string;
  current: TriggerBindingDto | null;
  binding: SlackTriggerBinding;
}) {
  const integrations = useIntegrations(workspaceId);
  const bind = useBindSlackTrigger(workspaceId, workflowId);
  const { toast } = useToast();
  const teams = (integrations.data ?? []).filter((i) => i.type === "slack");
  const [selected, setSelected] = useState<string>(current?.integrationId ?? "");

  async function save() {
    const integrationId = selected || teams[0]?.id;
    if (!integrationId) return;
    try {
      await bind.mutateAsync({ integrationId, binding });
      toast({ variant: "success", message: "Slack trigger bound." });
    } catch (error) {
      toast({ variant: "error", message: errorMessage(error, "Could not bind Slack.") });
    }
  }

  if (teams.length === 0) {
    return (
      <section className="rounded-card border border-black/[0.07] bg-white/40 p-4">
        <p className="text-[13px] text-ink-3">
          No Slack workspace is connected yet. Connect one in{" "}
          <span className="font-medium text-ink-2">Settings → Integrations</span>, then
          bind it here.
        </p>
      </section>
    );
  }

  const boundTeam = teams.find((t) => t.id === current?.integrationId);

  return (
    <section className="flex flex-col gap-3 rounded-card border border-black/[0.07] bg-white/40 p-4">
      <h3 className="text-[13.5px] font-semibold text-ink">Connected Slack workspace</h3>
      <div className="flex items-end gap-2.5">
        <div className="flex-1">
          <Select
            label="Team"
            value={selected || teams[0]!.id}
            onChange={(event) => setSelected(event.currentTarget.value)}
            options={teams.map((t) => ({
              value: t.id,
              label: t.teamName ?? t.externalId,
            }))}
          />
        </div>
        <Button size="sm" className="h-10" loading={bind.isPending} onClick={() => void save()}>
          {current?.integrationId ? "Update binding" : "Bind"}
        </Button>
      </div>
      {boundTeam ? (
        <div className="flex items-center gap-2">
          <StatusChip tone="success" dot>
            Bound
          </StatusChip>
          <p className="text-[12.5px] text-ink-3">
            Listening in <span className="font-medium">{boundTeam.teamName ?? boundTeam.externalId}</span>
            {binding.mentionOnly ? " · mentions only" : " · all messages"}
            {binding.includeDirectMessages ? " · DMs on" : ""}.
          </p>
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-4">
          Channel + mention rules are set above; binding saves them for this workspace.
        </p>
      )}
    </section>
  );
}
