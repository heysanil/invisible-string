import { Blocks, Plus } from "lucide-react";
import { useState } from "react";
import type { McpConnectionDto } from "@invisible-string/shared";

import { parseBlockingReference, type BlockingReference } from "../../lib/blocker";
import { errorMessage } from "../../lib/forms";
import {
  useDeleteMcpConnection,
  useMcpConnections,
  useToggleMcpConnection,
} from "../../lib/queries/mcp-connections";
import type { ScopeRef } from "../../lib/queries/keys";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { SkeletonList } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { McpConnectionCard } from "./McpConnectionCard";

export interface McpConnectionsGridProps {
  scope: ScopeRef;
  onAdd: () => void;
  readOnly: boolean;
}

export function McpConnectionsGrid({ scope, onAdd, readOnly }: McpConnectionsGridProps) {
  const connections = useMcpConnections(scope);
  const toggle = useToggleMcpConnection(scope);
  const remove = useDeleteMcpConnection(scope);
  const { toast } = useToast();

  const [pendingDelete, setPendingDelete] = useState<McpConnectionDto | null>(null);
  const [blocker, setBlocker] = useState<BlockingReference | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      await remove.mutateAsync(target.id);
      toast({ variant: "success", message: `${target.name} removed.` });
      setPendingDelete(null);
    } catch (error) {
      const blocking = parseBlockingReference(error);
      if (blocking) {
        setPendingDelete(null);
        setBlocker(blocking);
        return;
      }
      toast({ variant: "error", message: errorMessage(error) });
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-ink">Connections</h2>
          {connections.data ? (
            <span className="text-[12px] text-ink-4">{connections.data.length}</span>
          ) : null}
        </div>
        {readOnly ? null : (
          <Button variant="ghost" size="sm" onClick={onAdd}>
            <Plus size={14} aria-hidden="true" />
            Add connection
          </Button>
        )}
      </div>

      {connections.isPending ? (
        <SkeletonList rows={2} />
      ) : connections.isError ? (
        <ErrorState
          compact
          message={errorMessage(connections.error)}
          onRetry={() => void connections.refetch()}
        />
      ) : connections.data.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No connections yet"
          description={
            readOnly
              ? "No MCP servers have been connected here yet."
              : "Connect an MCP server so your agents can use its tools."
          }
          action={
            readOnly ? undefined : (
              <Button variant="ghost" size="sm" onClick={onAdd}>
                <Plus size={14} aria-hidden="true" />
                Add connection
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {connections.data.map((connection) => (
            <McpConnectionCard
              key={connection.id}
              connection={connection}
              readOnly={readOnly}
              onToggle={(enabled) =>
                toggle.mutate(
                  { connectionId: connection.id, enabled },
                  {
                    onError: (error) =>
                      toast({ variant: "error", message: errorMessage(error) }),
                  },
                )
              }
              onDelete={() => setPendingDelete(connection)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title={`Remove ${pendingDelete?.name ?? "connection"}?`}
        description="Workflows that reference this connection will no longer be able to use its tools."
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
        description="This connection is referenced by published workflows. Update or unpublish them first, then remove it."
      >
        {blocker && blocker.workflowNames.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-1.5">
            {blocker.workflowNames.map((name) => (
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
    </section>
  );
}
