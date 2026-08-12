/**
 * Publish state machine — models the agent rail's Publish capsule
 * progression (compiling → building → ready) and its error surface,
 * decoupled from React so it can be unit-tested exhaustively.
 *
 * The publish endpoint (`POST .../agents/:agentId/publish`) returns as soon as
 * the version row exists — the build continues server-side — so the client
 * presents staged progress and polls
 * `GET .../versions/:versionId/build` until it settles. Transitions:
 *
 *   idle ──start──▶ compiling ──received(building)──▶ building ─┐
 *                        │                                      │
 *                        └────────── received(succeeded/cached) ┴─▶ ready
 *   any ──received(failed)──▶ error(buildError)
 *   any ──failed(message)──▶ error(message)   (network / non-2xx)
 *   ready|error ──reset──▶ idle
 *
 * This module stays React-free AND transport-free: the reducer plus the pure
 * label/announcement helpers below. Who drives it (and who owns the poll that
 * outlives the editor) is `publish-store.ts`.
 */
import type {
  BuildStatus,
  PublishAgentResponse,
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
  result: PublishAgentResponse | null;
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
  | { type: "received"; response: PublishAgentResponse }
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

/** Settled — nothing more will arrive for this publish without a new one. */
export function isPublishTerminal(state: PublishState): boolean {
  return state.phase === "ready" || state.phase === "error";
}

// ── Completion announcement ─────────────────────────────────────────────────

/** A toast the publish store hands to whatever sink is installed. */
export interface PublishAnnouncement {
  variant: "success" | "error";
  message: string;
}

/** Longest build-error excerpt a toast carries (the rail shows the rest). */
const ANNOUNCEMENT_ERROR_MAX = 140;

/**
 * The toast a settled publish raises, NAMING the agent — a build that lands
 * after the user has navigated away is announced from the workspace store,
 * where the only identifying context left is the name we captured at publish.
 *
 * Returns null for every non-terminal phase, so the caller can announce
 * unconditionally on each transition and only the settling one speaks.
 */
export function publishAnnouncement(
  agentName: string,
  state: PublishState,
): PublishAnnouncement | null {
  if (state.phase === "ready") {
    return {
      variant: "success",
      message: state.result?.cached
        ? `“${agentName}” published — build served from cache.`
        : `“${agentName}” published and built.`,
    };
  }
  if (state.phase === "error") {
    const detail = firstLine(state.error ?? "");
    return {
      variant: "error",
      message: detail
        ? `“${agentName}” failed to publish. ${detail}`
        : `“${agentName}” failed to publish.`,
    };
  }
  return null;
}

// ── Publish → chat ──────────────────────────────────────────────────────────

/** What "Chat with agent" should do with a publish that just answered. */
export interface ChatEntryDecision {
  /** Navigate into the thread. */
  enter: boolean;
  /** Warn first: the version exists but its build has not landed yet. */
  warnStillBuilding: boolean;
}

/**
 * Publish-then-chat (spec D2). The old rule was "enter only once the build
 * SUCCEEDED", which meant holding the user on a spinner for the length of an
 * `eve build`. The new rule separates the two things a build outcome tells us:
 *
 * - `failed` — there is nothing to chat with. The rail carries the compiler
 *   output, so stay in the editor rather than dropping the user into a thread
 *   whose first message would 409 `version_not_ready`.
 * - still building — enter, but SAY SO. The session's first message needs a
 *   ready build, and raw protocol copy is not an explanation.
 * - succeeded — enter quietly.
 * - null (the POST itself failed) — the store already surfaced it.
 */
export function chatEntryDecision(
  response: PublishAgentResponse | null,
): ChatEntryDecision {
  if (response === null || response.buildStatus === "failed") {
    return { enter: false, warnStillBuilding: false };
  }
  return {
    enter: true,
    warnStillBuilding: response.buildStatus !== "succeeded",
  };
}

/** First non-empty line, clamped — build errors are multi-line stack dumps. */
function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  if (line === undefined) return "";
  const trimmed = line.trim();
  return trimmed.length > ANNOUNCEMENT_ERROR_MAX
    ? `${trimmed.slice(0, ANNOUNCEMENT_ERROR_MAX - 1)}…`
    : trimmed;
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
            "The build failed. Check the agent configuration and try again.",
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
