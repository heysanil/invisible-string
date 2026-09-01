/**
 * The workflow shell's shared state seam. The $workflowId LAYOUT route owns
 * the builder controller (header save state, publish, run gate) and provides
 * this context; the editor/runs children consume it via
 * {@link useWorkflowShell}. It lives here — not in the route file — because
 * the router's autoCodeSplitting rewrites route modules, and non-route
 * exports from them are not a supported import surface.
 */
import { createContext, useContext } from "react";
import type {
  AgentSummaryDto,
  RunDto,
  WorkflowConfig,
  WorkflowDto,
} from "@invisible-string/shared";

import type { ContextResources } from "../builder/resources";
import type { BuilderController } from "../builder/useBuilderController";

export interface WorkflowShellState {
  workspaceId: string;
  workflow: WorkflowDto;
  controller: BuilderController;
  resources: ContextResources;
  agents: readonly AgentSummaryDto[] | null;
  agentsError: boolean;
  onRetryAgents: () => void;
  isPublished: boolean;
  /** Shape-guarded published snapshot; null while never published/invalid. */
  publishedConfig: WorkflowConfig | null;
  /** A run just started from the header's Run popover (editor overlay). */
  startedRun: RunDto | null;
  dismissStartedRun: () => void;
}

export const WorkflowShellContext = createContext<WorkflowShellState | null>(
  null,
);

export function useWorkflowShell(): WorkflowShellState {
  const state = useContext(WorkflowShellContext);
  if (state === null) {
    throw new Error("useWorkflowShell must render inside the workflow shell");
  }
  return state;
}
