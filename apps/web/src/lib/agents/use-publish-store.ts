/**
 * React bindings for the workspace-level publish store (`publish-store.ts`).
 * Kept in their own module so the store itself stays React-free and unit
 * testable without a renderer.
 *
 * `useAgentPublishSink` is mounted by the agent surfaces (editor + grid); it
 * installs the toast/refresh sink and tells the store which workspace is
 * active. Note what it does NOT do: it never clears the sink on unmount. That
 * is the whole point of D2 — a build that lands after you have navigated to
 * /chat must still announce itself, and `toast` is owned by the root
 * `ToastProvider`, so holding it past this component's life is safe.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { invalidateAgents } from "../queries/agents";
import { useToast } from "../../components/ui/Toast";
import { agentPublishStore, type AgentPublishStore } from "./publish-store";
import type { PublishState } from "./publish-machine";

/** Subscribe to one agent's publish state (idle when nothing is watched). */
export function useAgentPublishState(
  agentId: string,
  store: AgentPublishStore = agentPublishStore,
): PublishState {
  return useSyncExternalStore(
    store.subscribe,
    () => store.stateOf(agentId),
    () => store.stateOf(agentId),
  );
}

/** Install the announcement sink and scope the store to this workspace. */
export function useAgentPublishSink(
  workspaceId: string,
  store: AgentPublishStore = agentPublishStore,
): void {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    store.setSink({
      toast: (announcement) => toast(announcement),
      settled: (watch) => {
        // The list row's buildStatus just changed (and publishedVersionId /
        // publishedDefinition moved at publish) — refresh both.
        void invalidateAgents(queryClient, watch.workspaceId);
      },
    });
    // No teardown, deliberately — see the module header.
  }, [store, toast, queryClient]);

  useEffect(() => {
    store.setActiveWorkspace(workspaceId);
  }, [store, workspaceId]);
}
