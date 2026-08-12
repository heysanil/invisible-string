/**
 * React bindings for the workspace-level publish store (`publish-store.ts`).
 * Kept in their own module so the store itself stays React-free and unit
 * testable without a renderer.
 *
 * {@link useAgentPublishBinding} is mounted ONCE, by the authenticated shell
 * (components/AppShell.tsx) — never by the agent surfaces. Both halves of it
 * are workspace-level facts, and neither survives being scoped to a screen:
 *
 * - the toast/refresh sink is deliberately never cleared on unmount — that is
 *   the point of D2: a build that lands after you have navigated to /chat must
 *   still announce itself, and `toast` is owned by the root `ToastProvider`,
 *   so holding it past a component's life is safe;
 * - `setActiveWorkspace` is what tears watches down when the user LEAVES a
 *   workspace, and that can happen from anywhere. Mounted on the agent screens
 *   it only ever ran where a workspace id was already in hand, so accepting an
 *   invitation from /chat activated workspace B while a watch on workspace A
 *   kept polling, invalidating A's queries and announcing A's build over B.
 *
 * The two halves stay separately callable so the workspace pin is testable
 * without an auth session — only the composite reads the active organization.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { invalidateAgents } from "../queries/agents";
import { useActiveWorkspaceId } from "../workspace";
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

/** Install the announcement sink. Sticky by design — see the module header. */
export function useAgentPublishSink(
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
}

/**
 * Pin the store to a workspace. `null` = not resolved yet (a fresh load, or
 * the moment right after `setActive` while the org query refetches) and is
 * NOT reported as a change: doing so would cancel a watch the user has not
 * left, which is the very failure this pin exists to prevent.
 */
export function useAgentPublishWorkspace(
  workspaceId: string | null,
  store: AgentPublishStore = agentPublishStore,
): void {
  useEffect(() => {
    if (workspaceId === null) return;
    store.setActiveWorkspace(workspaceId);
  }, [store, workspaceId]);
}

/**
 * What the authenticated shell mounts: the sink plus the ACTIVE workspace,
 * read from the same resolver the routes use, so the pin tracks the user
 * wherever they are — including screens that have nothing to do with agents.
 */
export function useAgentPublishBinding(
  store: AgentPublishStore = agentPublishStore,
): void {
  const { workspaceId } = useActiveWorkspaceId();
  useAgentPublishSink(store);
  useAgentPublishWorkspace(workspaceId, store);
}
