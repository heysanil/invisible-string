import { Blocks, Plus } from "lucide-react";
import type { ConnectionDto } from "@invisible-string/shared";

import { errorMessage } from "../../lib/forms";
import { useConnections, useToggleConnection } from "../../lib/queries/connections";
import type { ScopeRef } from "../../lib/queries/keys";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { SkeletonList } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { McpConnectionCard } from "./McpConnectionCard";

export interface McpConnectionsGridProps {
  scope: ScopeRef;
  onAdd: () => void;
  /** Open the connection detail slide-over (delete lives in its danger zone). */
  onOpen: (connection: ConnectionDto) => void;
  readOnly: boolean;
}

export function McpConnectionsGrid({
  scope,
  onAdd,
  onOpen,
  readOnly,
}: McpConnectionsGridProps) {
  const connections = useConnections(scope);
  const toggle = useToggleConnection(scope);
  const { toast } = useToast();

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
              onOpen={() => onOpen(connection)}
              onToggle={(enabled) =>
                toggle.mutate(
                  { connectionId: connection.id, enabled },
                  {
                    onError: (error) =>
                      toast({ variant: "error", message: errorMessage(error) }),
                  },
                )
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
