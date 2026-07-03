/**
 * Publish state machine — models the rail's Publish capsule progression
 * (compiling → building → ready) and its error surface, decoupled from React
 * so it can be unit-tested exhaustively.
 *
 * The publish endpoint (`POST .../publish`) is a single call that snapshots +
 * compiles + builds, returning a {@link PublishWorkflowResponse}; we present
 * it as staged progress because a cache MISS runs a real `eve build` that
 * takes seconds. Transitions:
 *
 *   idle ──start──▶ compiling ──received(building)──▶ building ─┐
 *                        │                                      │
 *                        └────────── received(succeeded/cached) ┴─▶ ready
 *   any ──received(failed)──▶ error(buildError)
 *   any ──failed(message)──▶ error(message)   (network / non-2xx)
 *   ready|error ──reset──▶ idle
 */
import type {
  BuildStatus,
  PublishWorkflowResponse,
} from "@invisible-string/shared";

export type PublishPhase =
  | "idle"
  | "compiling"
  | "building"
  | "ready"
  | "error";

export interface PublishState {
  phase: PublishPhase;
  /** Populated in "ready". */
  result: PublishWorkflowResponse | null;
  /** Populated in "error". */
  error: string | null;
}

export const INITIAL_PUBLISH_STATE: PublishState = {
  phase: "idle",
  result: null,
  error: null,
};

export type PublishEvent =
  | { type: "start" }
  | { type: "received"; response: PublishWorkflowResponse }
  | { type: "failed"; message: string }
  | { type: "reset" };

/** Human label for the current phase (rail capsule + inline status). */
export function publishPhaseLabel(state: PublishState): string {
  switch (state.phase) {
    case "idle":
      return "Publish";
    case "compiling":
      return "Compiling…";
    case "building":
      return "Building…";
    case "ready":
      return state.result?.cached ? "Published (cached)" : "Published";
    case "error":
      return "Publish failed";
  }
}

export function isPublishBusy(state: PublishState): boolean {
  return state.phase === "compiling" || state.phase === "building";
}

function phaseForBuildStatus(status: BuildStatus): PublishPhase {
  switch (status) {
    case "pending":
      return "compiling";
    case "building":
      return "building";
    case "succeeded":
      return "ready";
    case "failed":
      return "error";
  }
}

export function publishReducer(
  state: PublishState,
  event: PublishEvent,
): PublishState {
  switch (event.type) {
    case "start":
      // Re-entrant starts are ignored while a publish is in flight.
      if (isPublishBusy(state)) return state;
      return { phase: "compiling", result: null, error: null };

    case "received": {
      const { response } = event;
      if (response.buildStatus === "failed") {
        return {
          phase: "error",
          result: response,
          error:
            response.buildError?.trim() ||
            "The build failed. Check the workflow configuration and try again.",
        };
      }
      const phase = phaseForBuildStatus(response.buildStatus);
      return {
        phase,
        result: phase === "ready" ? response : null,
        error: null,
      };
    }

    case "failed":
      return { phase: "error", result: null, error: event.message };

    case "reset":
      return INITIAL_PUBLISH_STATE;
  }
}
