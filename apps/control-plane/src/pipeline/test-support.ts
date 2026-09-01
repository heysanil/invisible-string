/**
 * Shared in-memory fakes for the pipeline unit suites (runner/recovery/
 * events) — the tailer.test.ts memoryStore pattern, extracted because three
 * suites need the same RunStore/lock/run-row fakes. Not a `.test.ts` file,
 * so `bun test` never collects it directly.
 */
import { randomUUID } from "node:crypto";

import type {
  AgentSessionStatus,
  EveStreamEvent,
  RunStatus,
  TriggerEvent,
} from "@invisible-string/shared";

import type { RunStatusPatch, RunStore, StoredRunEvent } from "../runs/store";
import type { PipelineLockFactory, RunRow } from "./runner";

const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "canceled"];

export interface MemoryRunStore extends RunStore {
  events: Array<{ runId: string; seq: number; event: EveStreamEvent }>;
  statuses: Map<string, { status: RunStatus; error: string | null }>;
  /** Every accepted markRun patch, in order (per-run CAS applied). */
  statusLog: Array<{ runId: string; patch: RunStatusPatch }>;
  deliveryMarks: Array<{ runId: string; status: "delivered" | "failed" }>;
  sessionMarks: Array<{ sessionId: string; status: AgentSessionStatus }>;
  setStatus(runId: string, status: RunStatus, error?: string | null): void;
}

export function createMemoryRunStore(): MemoryRunStore {
  const store: MemoryRunStore = {
    events: [],
    statuses: new Map(),
    statusLog: [],
    deliveryMarks: [],
    sessionMarks: [],
    setStatus(runId, status, error = null) {
      store.statuses.set(runId, { status, error });
    },
    async appendEvent(runId, seq, event): Promise<StoredRunEvent> {
      if (store.events.some((e) => e.runId === runId && e.seq === seq)) {
        throw new Error(`duplicate seq ${seq} for run ${runId} (PK violation)`);
      }
      store.events.push({ runId, seq, event });
      return { seq, event, at: new Date().toISOString() };
    },
    async countRunEvents(runId) {
      return store.events.filter((e) => e.runId === runId).length;
    },
    async countSessionEvents() {
      return 0; // pipeline runs are sessionless
    },
    async listEventsAfter(runId, afterSeq) {
      return store.events
        .filter((e) => e.runId === runId && e.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({
          seq: e.seq,
          event: e.event,
          at: new Date().toISOString(),
        }));
    },
    async listEventIds() {
      return [];
    },
    async markRun(runId, patch) {
      const current = store.statuses.get(runId);
      // Mirror the drizzle CAS: terminal statuses are sticky.
      if (current && TERMINAL.includes(current.status)) return false;
      store.statusLog.push({ runId, patch });
      store.statuses.set(runId, {
        status: patch.status,
        error: patch.error ?? current?.error ?? null,
      });
      return true;
    },
    async getRunStatus(runId) {
      return store.statuses.get(runId) ?? null;
    },
    async markDelivery(runId, status) {
      store.deliveryMarks.push({ runId, status });
      return true;
    },
    async markSession(sessionId, status) {
      store.sessionMarks.push({ sessionId, status });
    },
  };
  return store;
}

export interface MemoryLocks {
  held: Set<string>;
  acquired: string[];
  released: string[];
  /** Pre-hold a run id so tryAcquire returns null (contention). */
  hold(runId: string): void;
  factory: PipelineLockFactory;
}

export function createMemoryLocks(): MemoryLocks {
  const held = new Set<string>();
  const acquired: string[] = [];
  const released: string[] = [];
  const locks: MemoryLocks = {
    held,
    acquired,
    released,
    hold(runId) {
      held.add(runId);
    },
    factory: {
      async tryAcquire(runId) {
        if (held.has(runId)) return null;
        held.add(runId);
        acquired.push(runId);
        return {
          async release() {
            held.delete(runId);
            released.push(runId);
          },
        };
      },
    },
  };
  return locks;
}

export function makeTriggerEvent(
  overrides: Partial<TriggerEvent> = {},
): TriggerEvent {
  return {
    agentId: randomUUID(),
    workflowId: randomUUID(),
    triggerType: "manual",
    message: "",
    data: {},
    principal: { workspaceId: "org-test", source: "test" },
    ...overrides,
  };
}

export function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: randomUUID(),
    agentSessionId: null,
    organizationId: "org-test",
    workflowId: randomUUID(),
    mode: "pipeline",
    triggerEvent: makeTriggerEvent() as unknown as Record<string, unknown>,
    taskMessage: null,
    eveRunId: null,
    status: "queued",
    deliveryStatus: null,
    deliveryError: null,
    startedAt: null,
    completedAt: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Poll the memory store until the run settles (unit-test scale timeout). */
export async function waitForTerminal(
  store: MemoryRunStore,
  runId: string,
  timeoutMs = 2_000,
): Promise<{ status: RunStatus; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = store.statuses.get(runId);
    if (current && TERMINAL.includes(current.status)) return current;
    await Bun.sleep(2);
  }
  throw new Error(`run ${runId} did not settle within ${timeoutMs}ms`);
}

/** Poll until a predicate holds (park/cancel choreography helpers). */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`);
}
