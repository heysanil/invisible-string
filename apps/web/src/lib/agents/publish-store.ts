/**
 * The WORKSPACE-level publish store (2026-08-11 spec D2).
 *
 * `POST .../agents/:agentId/publish` has always returned the moment the
 * version row exists — the `eve build` finishes server-side afterwards — and
 * `GET .../versions/:versionId/build` has always existed to watch it. What
 * was missing is an owner for that watch that OUTLIVES the editor: the poll
 * used to live in `useAgentController`, cancelled on unmount, so publishing
 * and then navigating away (the very thing "Chat with agent" does) silently
 * abandoned the build and the user learned nothing about it.
 *
 * This store is that owner. It is a module singleton, deliberately outside
 * React: watches live in a plain Map, the poll loop is a bare async function
 * guarded by a per-agent generation counter, and subscribers attach through
 * `useSyncExternalStore` (see `use-publish-store.ts`). An editor mount/unmount
 * is invisible to a running watch; only a WORKSPACE change tears watches down.
 *
 * The completion toast is raised through an installed {@link AgentPublishSink}.
 * The sink is installed by any agent surface and is deliberately NOT removed
 * on unmount: `toast` comes from the root `ToastProvider` and stays valid for
 * the lifetime of the app, and holding it is precisely what lets a build that
 * lands while the user sits in /chat still announce itself by name. (Nothing
 * here can leak an interval — the loop owns a single pending `sleep` and stops
 * the moment its generation is superseded.)
 *
 * No durable queue, no boot reconcile: a page reload loses the watch and the
 * agent's `buildStatus` on the list row is the source of truth after that.
 */
import type { PublishAgentResponse } from "@invisible-string/shared";

import {
  INITIAL_PUBLISH_STATE,
  isPublishTerminal,
  publishAnnouncement,
  publishReducer,
  type PublishAnnouncement,
  type PublishState,
} from "./publish-machine";
import { fetchAgentBuildStatus } from "../queries/agents";

/** Poll cadence + ceiling (~25 min; a cold `eve build` runs minutes). */
const BUILD_POLL_INTERVAL_MS = 1500;
const BUILD_POLL_MAX_ATTEMPTS = 1000;

/** One agent's in-flight (or just-settled) publish. */
export interface AgentPublishWatch {
  workspaceId: string;
  agentId: string;
  /** Captured at publish — the toast names the agent from here. */
  agentName: string;
  /**
   * The publish POST's answer, null until it lands. The poll re-uses it
   * verbatim (only `buildStatus`/`buildError` move), so the settled state
   * still carries the real `contentHash`/`cached` the rail renders.
   */
  response: PublishAgentResponse | null;
  state: PublishState;
}

/**
 * Where completions are announced. `settled` fires on every terminal
 * transition so the caller can refresh the workspace's agent queries (the
 * list row's `buildStatus` changed).
 */
export interface AgentPublishSink {
  toast(announcement: PublishAnnouncement): void;
  settled?(watch: AgentPublishWatch): void;
}

export interface AgentPublishStoreOptions {
  fetchBuildStatus?: typeof fetchAgentBuildStatus;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AgentPublishStore {
  readonly #fetchBuildStatus: typeof fetchAgentBuildStatus;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #maxAttempts: number;

  #watches = new Map<string, AgentPublishWatch>();
  readonly #listeners = new Set<() => void>();
  /** Bumped per agent so a superseded poll loop exits on its next check. */
  readonly #generations = new Map<string, number>();
  #sink: AgentPublishSink | null = null;
  #activeWorkspaceId: string | null = null;

  constructor(options: AgentPublishStoreOptions = {}) {
    this.#fetchBuildStatus = options.fetchBuildStatus ?? fetchAgentBuildStatus;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#pollIntervalMs = options.pollIntervalMs ?? BUILD_POLL_INTERVAL_MS;
    this.#maxAttempts = options.maxAttempts ?? BUILD_POLL_MAX_ATTEMPTS;
  }

  // ── subscription (useSyncExternalStore) ───────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * The agent's publish state, or the shared idle constant. Identity is
   * stable between mutations — `useSyncExternalStore` re-renders on identity,
   * so returning a fresh object here would loop forever.
   */
  stateOf = (agentId: string): PublishState =>
    this.#watches.get(agentId)?.state ?? INITIAL_PUBLISH_STATE;

  watchOf(agentId: string): AgentPublishWatch | undefined {
    return this.#watches.get(agentId);
  }

  /** Every live watch (list surfaces can show build progress inline). */
  watches(): readonly AgentPublishWatch[] {
    return [...this.#watches.values()];
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  /**
   * Install the announcement sink. Deliberately sticky: see the module header
   * — the point of the store is that it speaks after its screen is gone.
   */
  setSink(sink: AgentPublishSink | null): void {
    this.#sink = sink;
  }

  /**
   * Switching workspaces drops every watch (a build in the workspace you just
   * left is not yours to announce, and its agent queries are gone too).
   */
  setActiveWorkspace(workspaceId: string): void {
    if (this.#activeWorkspaceId === workspaceId) return;
    this.#activeWorkspaceId = workspaceId;
    let changed = false;
    for (const watch of [...this.#watches.values()]) {
      if (watch.workspaceId === workspaceId) continue;
      this.#cancel(watch.agentId);
      this.#watches.delete(watch.agentId);
      changed = true;
    }
    if (changed) this.#commit();
  }

  // ── transitions ───────────────────────────────────────────────────────────

  /** A publish POST is going out. */
  begin(input: {
    workspaceId: string;
    agentId: string;
    agentName: string;
  }): void {
    const previous = this.#watches.get(input.agentId);
    this.#cancel(input.agentId);
    this.#write({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agentName: input.agentName,
      response: null,
      state: publishReducer(previous?.state ?? INITIAL_PUBLISH_STATE, {
        type: "start",
      }),
    });
  }

  /**
   * The POST answered. A terminal answer (cache hit, or a build that failed
   * before the response) settles immediately; anything else starts the
   * background poll — this call does NOT wait for the build.
   */
  received(agentId: string, response: PublishAgentResponse): void {
    const watch = this.#watches.get(agentId);
    if (!watch) return;
    const state = publishReducer(watch.state, { type: "received", response });
    const next = { ...watch, response, state };
    this.#write(next);
    if (isPublishTerminal(state)) {
      this.#announce(next);
      return;
    }
    this.#poll(agentId, this.#bump(agentId));
  }

  /** The POST itself failed (network / non-2xx). */
  failed(agentId: string, message: string): void {
    const watch = this.#watches.get(agentId);
    if (!watch) return;
    this.#cancel(agentId);
    const next = {
      ...watch,
      state: publishReducer(watch.state, { type: "failed", message }),
    };
    this.#write(next);
    this.#announce(next);
  }

  /** Clear an agent's watch (dismissing the rail's result card). */
  reset(agentId: string): void {
    if (!this.#watches.has(agentId)) return;
    this.#cancel(agentId);
    this.#watches = new Map(this.#watches);
    this.#watches.delete(agentId);
    this.#commit();
  }

  // ── the poll ──────────────────────────────────────────────────────────────

  #poll(agentId: string, generation: number): void {
    void (async () => {
      for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
        await this.#sleep(this.#pollIntervalMs);
        if (this.#generations.get(agentId) !== generation) return;
        const watch = this.#watches.get(agentId);
        if (!watch || watch.response === null) return;

        let status: Awaited<ReturnType<typeof fetchAgentBuildStatus>>;
        try {
          status = await this.#fetchBuildStatus(
            watch.workspaceId,
            agentId,
            watch.response.versionId,
          );
        } catch {
          // Transient poll failure — the build is still running; keep waiting.
          continue;
        }
        if (this.#generations.get(agentId) !== generation) return;

        const current = this.#watches.get(agentId);
        if (!current || current.response === null) return;
        const state = publishReducer(current.state, {
          type: "received",
          response: {
            ...current.response,
            buildStatus: status.status,
            buildError: status.error,
          },
        });
        const next = { ...current, state };
        this.#write(next);
        if (isPublishTerminal(state)) {
          this.#announce(next);
          return;
        }
      }
      // Ceiling reached (~25 min). The build may still be running server-side,
      // so we neither claim success nor invent a failure: the watch stays in
      // "Building…" and the agent's list row is the source of truth from here.
    })();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #bump(agentId: string): number {
    const next = (this.#generations.get(agentId) ?? 0) + 1;
    this.#generations.set(agentId, next);
    return next;
  }

  /** Supersede any running loop for this agent. */
  #cancel(agentId: string): void {
    this.#bump(agentId);
  }

  #write(watch: AgentPublishWatch): void {
    this.#watches = new Map(this.#watches);
    this.#watches.set(watch.agentId, watch);
    this.#commit();
  }

  #commit(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #announce(watch: AgentPublishWatch): void {
    const sink = this.#sink;
    if (!sink) return;
    const announcement = publishAnnouncement(watch.agentName, watch.state);
    if (announcement) sink.toast(announcement);
    sink.settled?.(watch);
  }
}

/** The app-wide store. Tests construct their own instance instead. */
export const agentPublishStore = new AgentPublishStore();
