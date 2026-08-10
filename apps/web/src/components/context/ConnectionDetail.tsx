/**
 * Connection detail slide-over (connectors redesign spec §10, plan-2 Task 4):
 * the one place a connection is fully managed. Sections — identity
 * (rename/description, 409 name collisions surfaced inline), endpoint
 * (editable for custom servers only), auth (type, credential shield, one-shot
 * rotation form), tool policy (the checkbox {@link ToolPicker} over the
 * cached tool list), approvals (default decision + per-tool overrides from
 * the cached tool list), health (badge, last checked, last error, Test
 * connection), and a danger zone carrying delete with the existing in-use
 * blocker.
 *
 * Stale re-probe (spec §7): opening the detail with `lastCheckedAt` null or
 * older than 15 minutes fires one automatic probe — guarded by a per-open ref
 * so invalidation-driven re-renders never loop it.
 */
import { ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ConnectionDto,
  ConnectionTool,
  McpApprovalDecision,
  UpdateConnectionRequest,
} from "@invisible-string/shared";

import { parseBlockingReference, type BlockingReference } from "../../lib/blocker";
import { cn } from "../../lib/cn";
import { formatRelativeTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import {
  useConnection,
  useDeleteConnection,
  useProbeConnection,
  useUpdateConnection,
} from "../../lib/queries/connections";
import type { ScopeRef } from "../../lib/queries/keys";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Drawer } from "../ui/Drawer";
import { ErrorState } from "../ui/ErrorState";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { SkeletonList } from "../ui/Skeleton";
import { Textarea } from "../ui/Textarea";
import { useToast } from "../ui/Toast";
import { HealthBadge } from "./HealthBadge";
import { ToolPicker } from "./ToolPicker";

/** Re-probe on open when the last check is older than this (spec §7). */
const STALE_PROBE_MS = 15 * 60 * 1000;

const AUTH_TYPE_LABEL: Record<ConnectionDto["authType"], string> = {
  none: "No credentials",
  bearer: "Bearer token",
  headers: "Custom headers",
  oauth: "OAuth",
};

const TRANSPORT_OPTIONS = [
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE" },
] as const;

const APPROVAL_OPTIONS: { value: McpApprovalDecision; label: string }[] = [
  { value: "never", label: "Never — auto-allow" },
  { value: "once", label: "Once per session" },
  { value: "always", label: "Always ask" },
];

export interface ConnectionDetailProps {
  scope: ScopeRef;
  connectionId: string;
  /** Members (read-only) see the same layout without mutating affordances. */
  readOnly: boolean;
  onClose: () => void;
}

export function ConnectionDetail({
  scope,
  connectionId,
  readOnly,
  onClose,
}: ConnectionDetailProps) {
  const connection = useConnection(scope, connectionId);
  const probe = useProbeConnection(scope);

  // Stale re-probe, once per open: evaluated when the DTO first arrives and
  // never again (the ref survives the invalidation-driven refetch the probe
  // itself causes). Members can't hit the canManage-gated probe route.
  const autoProbedRef = useRef(false);
  const { mutate: probeMutate } = probe;
  useEffect(() => {
    if (autoProbedRef.current || readOnly) return;
    const dto = connection.data;
    if (!dto) return;
    autoProbedRef.current = true;
    const stale =
      dto.lastCheckedAt === null ||
      Date.now() - Date.parse(dto.lastCheckedAt) > STALE_PROBE_MS;
    if (stale) probeMutate(connectionId);
  }, [connection.data, readOnly, probeMutate, connectionId]);

  const subtitle =
    connection.data === undefined
      ? undefined
      : connection.data.source === "registry"
        ? (connection.data.registryName ?? "Community server")
        : connection.data.source === "catalog"
          ? "Catalog connector"
          : "Custom server";

  return (
    <Drawer
      open
      onClose={onClose}
      title={connection.data?.name ?? "Connection"}
      description={subtitle}
      widthClassName="max-w-xl"
    >
      {connection.isPending ? (
        <SkeletonList rows={4} />
      ) : connection.isError ? (
        <ErrorState
          message={errorMessage(connection.error)}
          onRetry={() => void connection.refetch()}
        />
      ) : (
        <DetailBody
          scope={scope}
          connection={connection.data}
          readOnly={readOnly}
          probing={probe.isPending}
          onProbe={() => probeMutate(connectionId)}
          onClose={onClose}
        />
      )}
    </Drawer>
  );
}

// ── Body ────────────────────────────────────────────────────────────────────

function DetailBody({
  scope,
  connection,
  readOnly,
  probing,
  onProbe,
  onClose,
}: {
  scope: ScopeRef;
  connection: ConnectionDto;
  readOnly: boolean;
  probing: boolean;
  onProbe: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-6 pb-6">
      <IdentitySection scope={scope} connection={connection} readOnly={readOnly} />
      <EndpointSection scope={scope} connection={connection} readOnly={readOnly} />
      <AuthSection scope={scope} connection={connection} readOnly={readOnly} />
      <ToolPolicySection scope={scope} connection={connection} readOnly={readOnly} />
      <ApprovalSection scope={scope} connection={connection} readOnly={readOnly} />
      <HealthSection
        connection={connection}
        readOnly={readOnly}
        probing={probing}
        onProbe={onProbe}
      />
      {readOnly ? null : (
        <DangerSection scope={scope} connection={connection} onDeleted={onClose} />
      )}
    </div>
  );
}

function Section({
  title,
  danger = false,
  children,
}: {
  title: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-0.5 text-[12px] font-semibold uppercase tracking-wide text-ink-4">
        {title}
      </h3>
      <div
        className={cn(
          "flex flex-col gap-3 rounded-card-lg border bg-white/40 p-4",
          danger ? "border-err/25" : "border-black/[0.07]",
        )}
      >
        {children}
      </div>
    </section>
  );
}

// ── Identity ────────────────────────────────────────────────────────────────

function IdentitySection({
  scope,
  connection,
  readOnly,
}: {
  scope: ScopeRef;
  connection: ConnectionDto;
  readOnly: boolean;
}) {
  const update = useUpdateConnection(scope);
  const { toast } = useToast();
  const [name, setName] = useState(connection.name);
  const [description, setDescription] = useState(connection.description ?? "");
  const [nameError, setNameError] = useState<string | null>(null);

  const dirty =
    name !== connection.name || description !== (connection.description ?? "");

  async function save() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameError("A connection needs a name.");
      return;
    }
    setNameError(null);
    try {
      await update.mutateAsync({
        connectionId: connection.id,
        patch: { name: trimmed, description: description.trim() || null },
      });
      toast({ variant: "success", message: "Connection saved." });
    } catch (error) {
      // Name collisions (duplicate name / colliding slug) come back as 409 —
      // surface them inline on the field so the user can pick another name.
      const message = errorMessage(error);
      if (isNameConflict(error)) {
        setNameError(message);
      } else {
        toast({ variant: "error", message });
      }
    }
  }

  return (
    <Section title="Identity">
      <Input
        label="Name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        error={nameError}
        disabled={readOnly}
      />
      <Textarea
        label="Description"
        rows={2}
        placeholder="What agents should know this server is for."
        value={description}
        onChange={(event) => setDescription(event.currentTarget.value)}
        disabled={readOnly}
      />
      {readOnly ? null : (
        <div className="flex justify-end">
          <Button
            size="sm"
            loading={update.isPending}
            disabled={!dirty}
            onClick={() => void save()}
          >
            Save details
          </Button>
        </div>
      )}
    </Section>
  );
}

function isNameConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 409
  );
}

// ── Endpoint ────────────────────────────────────────────────────────────────

function EndpointSection({
  scope,
  connection,
  readOnly,
}: {
  scope: ScopeRef;
  connection: ConnectionDto;
  readOnly: boolean;
}) {
  const update = useUpdateConnection(scope);
  const { toast } = useToast();
  const [url, setUrl] = useState(connection.url);
  const [transport, setTransport] = useState<ConnectionDto["transport"]>(
    connection.transport,
  );
  const [urlError, setUrlError] = useState<string | null>(null);

  const editable = connection.source === "custom" && !readOnly;
  const dirty = url !== connection.url || transport !== connection.transport;

  async function save() {
    setUrlError(null);
    try {
      await update.mutateAsync({
        connectionId: connection.id,
        patch: { url: url.trim(), transport },
      });
      toast({ variant: "success", message: "Endpoint saved." });
    } catch (error) {
      setUrlError(errorMessage(error));
    }
  }

  if (!editable) {
    const transportLabel =
      TRANSPORT_OPTIONS.find((option) => option.value === connection.transport)
        ?.label ?? connection.transport;
    return (
      <Section title="Endpoint">
        <ReadOnlyRow label="Server URL" value={connection.url} mono />
        <ReadOnlyRow label="Transport" value={transportLabel} />
        {connection.source !== "custom" ? (
          <p className="px-0.5 text-[11.5px] leading-snug text-ink-4">
            Managed by the {connection.source === "catalog" ? "catalog" : "registry"}{" "}
            connector — the endpoint can’t be edited here.
          </p>
        ) : null}
      </Section>
    );
  }

  return (
    <Section title="Endpoint">
      <Input
        label="Server URL"
        value={url}
        onChange={(event) => setUrl(event.currentTarget.value)}
        error={urlError}
        placeholder="https://example.com/mcp"
      />
      <Select
        label="Transport"
        value={transport}
        options={TRANSPORT_OPTIONS}
        onChange={(event) =>
          setTransport(event.currentTarget.value as ConnectionDto["transport"])
        }
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          loading={update.isPending}
          disabled={!dirty}
          onClick={() => void save()}
        >
          Save endpoint
        </Button>
      </div>
    </Section>
  );
}

function ReadOnlyRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="px-0.5 text-[12px] font-medium text-ink-2">{label}</span>
      <span
        className={cn(
          "break-all px-0.5 text-[13px] text-ink-3",
          mono && "font-mono text-[12.5px]",
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ── Auth ────────────────────────────────────────────────────────────────────

function AuthSection({
  scope,
  connection,
  readOnly,
}: {
  scope: ScopeRef;
  connection: ConnectionDto;
  readOnly: boolean;
}) {
  const [rotating, setRotating] = useState(false);
  const canRotate =
    !readOnly &&
    (connection.authType === "bearer" || connection.authType === "headers");

  return (
    <Section title="Authentication">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-ink">
          {AUTH_TYPE_LABEL[connection.authType]}
        </span>
        {connection.hasCredentials ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">
            <ShieldCheck size={13} aria-hidden="true" />
            Credentials stored
          </span>
        ) : null}
      </div>
      {canRotate && !rotating ? (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setRotating(true)}>
            Rotate credentials
          </Button>
        </div>
      ) : null}
      {canRotate && rotating ? (
        <RotateAuthForm
          scope={scope}
          connection={connection}
          onDone={() => setRotating(false)}
        />
      ) : null}
    </Section>
  );
}

/**
 * One-shot credential rotation (CatalogSecretForm's pattern): values live in
 * local state, travel once in the encrypted `auth` PATCH field, and are never
 * read back — the form unmounts on success, dropping them.
 */
function RotateAuthForm({
  scope,
  connection,
  onDone,
}: {
  scope: ScopeRef;
  connection: ConnectionDto;
  onDone: () => void;
}) {
  const update = useUpdateConnection(scope);
  const { toast } = useToast();
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>([
    { name: "", value: "" },
  ]);
  const [formError, setFormError] = useState<string | null>(null);
  const bearer = connection.authType === "bearer";

  async function save() {
    let auth: UpdateConnectionRequest["auth"];
    if (bearer) {
      if (token.trim().length === 0) {
        setFormError("Enter the new token.");
        return;
      }
      auth = { type: "bearer", values: { token: token.trim() } };
    } else {
      const values = Object.fromEntries(
        headers
          .map((header) => [header.name.trim(), header.value.trim()] as const)
          .filter(([name, value]) => name.length > 0 && value.length > 0),
      );
      if (Object.keys(values).length === 0) {
        setFormError("Add at least one header name and value.");
        return;
      }
      auth = { type: "headers", values };
    }
    setFormError(null);
    try {
      await update.mutateAsync({ connectionId: connection.id, patch: { auth } });
      toast({ variant: "success", message: "Credentials updated." });
      onDone();
    } catch (error) {
      setFormError(errorMessage(error));
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-card border border-black/[0.07] bg-white/50 p-3">
      <p className="text-[12px] leading-relaxed text-ink-4">
        Stored encrypted and sent to the server on your behalf. You will not see
        these values again.
      </p>
      {bearer ? (
        <Input
          label="New token"
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {headers.map((header, index) => (
            <div key={index} className="grid grid-cols-2 gap-2">
              <Input
                label={index === 0 ? "Header name" : `Header name ${index + 1}`}
                value={header.name}
                placeholder="X-Api-Key"
                onChange={(event) => {
                  const next = [...headers];
                  next[index] = { ...next[index]!, name: event.currentTarget.value };
                  setHeaders(next);
                }}
              />
              <Input
                label={index === 0 ? "Header value" : `Header value ${index + 1}`}
                type="password"
                autoComplete="new-password"
                value={header.value}
                onChange={(event) => {
                  const next = [...headers];
                  next[index] = { ...next[index]!, value: event.currentTarget.value };
                  setHeaders(next);
                }}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setHeaders([...headers, { name: "", value: "" }])}
            className="lift w-fit rounded-capsule px-2 py-1 text-[12px] font-medium text-ink-3 hover:bg-black/[0.04] hover:text-ink"
          >
            + Add header
          </button>
        </div>
      )}
      {formError ? (
        <p role="alert" className="text-[12.5px] text-err">
          {formError}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={update.isPending}>
          Cancel
        </Button>
        <Button size="sm" loading={update.isPending} onClick={() => void save()}>
          Save credentials
        </Button>
      </div>
    </div>
  );
}

// ── Tool policy ─────────────────────────────────────────────────────────────

/** Allow/block filter — the checkbox picker over the cached tool list. */
function ToolPolicySection({
  scope,
  connection,
  readOnly,
}: {
  scope: ScopeRef;
  connection: ConnectionDto;
  readOnly: boolean;
}) {
  const update = useUpdateConnection(scope);
  const { toast } = useToast();

  return (
    <Section title="Tool policy">
      <ToolPicker
        connection={connection}
        readOnly={readOnly}
        onChange={(patch) =>
          update.mutate(
            { connectionId: connection.id, patch },
            {
              onError: () =>
                toast({
                  variant: "error",
                  message: "Could not save the tool filter.",
                }),
            },
          )
        }
      />
    </Section>
  );
}

// ── Approvals ───────────────────────────────────────────────────────────────

/** Tools the filter leaves reachable — the set worth per-tool overrides. */
function effectiveTools(connection: ConnectionDto): ConnectionTool[] {
  if (!connection.tools) return [];
  if (connection.toolAllow && connection.toolAllow.length > 0) {
    const allowed = new Set(connection.toolAllow);
    return connection.tools.filter((tool) => allowed.has(tool.name));
  }
  if (connection.toolBlock && connection.toolBlock.length > 0) {
    const blocked = new Set(connection.toolBlock);
    return connection.tools.filter((tool) => !blocked.has(tool.name));
  }
  return connection.tools;
}

function ApprovalSection({
  scope,
  connection,
  readOnly,
}: {
  scope: ScopeRef;
  connection: ConnectionDto;
  readOnly: boolean;
}) {
  const update = useUpdateConnection(scope);
  const { toast } = useToast();
  const policy = connection.approvalPolicy;
  const currentDefault = policy?.default ?? "never";
  const overrides = policy?.tools ?? {};
  const tools = useMemo(() => effectiveTools(connection), [connection]);

  function persist(patch: UpdateConnectionRequest) {
    update.mutate(
      { connectionId: connection.id, patch },
      {
        onError: () =>
          toast({ variant: "error", message: "Could not save the approval policy." }),
      },
    );
  }

  function setDefault(decision: McpApprovalDecision) {
    persist({
      approvalPolicy: {
        default: decision,
        ...(Object.keys(overrides).length > 0 ? { tools: overrides } : {}),
      },
    });
  }

  function setOverride(name: string, decision: "" | McpApprovalDecision) {
    const next = { ...overrides };
    if (decision === "") delete next[name];
    else next[name] = decision;
    persist({
      approvalPolicy: {
        default: currentDefault,
        ...(Object.keys(next).length > 0 ? { tools: next } : {}),
      },
    });
  }

  return (
    <Section title="Approvals">
      <Select
        label="Default approval"
        value={currentDefault}
        options={APPROVAL_OPTIONS}
        disabled={readOnly}
        onChange={(event) =>
          setDefault(event.currentTarget.value as McpApprovalDecision)
        }
      />
      {tools.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="px-0.5 text-[12px] font-medium text-ink-2">
            Per-tool overrides
          </span>
          <ul className="flex flex-col gap-1.5">
            {tools.map((tool) => (
              <li
                key={tool.name}
                className="flex items-center justify-between gap-3 rounded-card border border-black/[0.06] bg-white/50 py-1.5 pl-3 pr-1.5"
              >
                <span
                  className="truncate font-mono text-[12px] text-ink"
                  title={tool.description || undefined}
                >
                  {tool.name}
                </span>
                <Select
                  label={`${tool.name} approval`}
                  srOnlyLabel
                  value={overrides[tool.name] ?? ""}
                  options={[{ value: "", label: "Use default" }, ...APPROVAL_OPTIONS]}
                  disabled={readOnly}
                  className="h-8 w-44 text-[12.5px]"
                  onChange={(event) =>
                    setOverride(
                      tool.name,
                      event.currentTarget.value as "" | McpApprovalDecision,
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="px-0.5 text-[11.5px] leading-snug text-ink-4">
          Per-tool overrides appear once the tool list has been discovered — run
          Test connection.
        </p>
      )}
    </Section>
  );
}

// ── Health ──────────────────────────────────────────────────────────────────

function HealthSection({
  connection,
  readOnly,
  probing,
  onProbe,
}: {
  connection: ConnectionDto;
  readOnly: boolean;
  probing: boolean;
  onProbe: () => void;
}) {
  return (
    <Section title="Health">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <HealthBadge health={connection.health} />
          <span className="text-[12px] text-ink-4">
            {connection.lastCheckedAt
              ? `Checked ${formatRelativeTime(connection.lastCheckedAt)}`
              : "Never checked"}
          </span>
        </div>
        {readOnly ? null : (
          <Button variant="ghost" size="sm" loading={probing} onClick={onProbe}>
            Test connection
          </Button>
        )}
      </div>
      {connection.lastError ? (
        <p className="break-words rounded-card border border-err/20 bg-err/[0.04] px-3 py-2 font-mono text-[12px] leading-relaxed text-err">
          {connection.lastError}
        </p>
      ) : null}
    </Section>
  );
}

// ── Danger zone ─────────────────────────────────────────────────────────────

function DangerSection({
  scope,
  connection,
  onDeleted,
}: {
  scope: ScopeRef;
  connection: ConnectionDto;
  onDeleted: () => void;
}) {
  const remove = useDeleteConnection(scope);
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [blocker, setBlocker] = useState<BlockingReference | null>(null);

  async function confirmDelete() {
    try {
      await remove.mutateAsync(connection.id);
      toast({ variant: "success", message: `${connection.name} removed.` });
      setConfirming(false);
      onDeleted();
    } catch (error) {
      const blocking = parseBlockingReference(error);
      if (blocking) {
        setConfirming(false);
        setBlocker(blocking);
        return;
      }
      toast({ variant: "error", message: errorMessage(error) });
    }
  }

  return (
    <Section title="Danger zone" danger>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          Agents that use this connection will no longer be able to reach its
          tools.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 border-err/30 text-err hover:border-err/50 hover:bg-err/[0.06]"
          onClick={() => setConfirming(true)}
        >
          Remove connection
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void confirmDelete()}
        title={`Remove ${connection.name}?`}
        description="Agents that use this connection will no longer be able to reach its tools."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
      />

      <ConfirmDialog
        open={blocker !== null}
        onClose={() => setBlocker(null)}
        onConfirm={() => setBlocker(null)}
        blocker
        title="Still in use"
        description="The agents below still use this connection (in their draft or a published version). Detach it from each agent's context first, then remove it."
      >
        {blocker && blocker.blockingNames.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-1.5">
            {blocker.blockingNames.map((name) => (
              <li
                key={name}
                className="flex items-center gap-2 rounded-card border border-black/[0.06] bg-white/50 px-3 py-2 text-[13px] text-ink-2"
              >
                <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />
                {name}
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
    </Section>
  );
}
