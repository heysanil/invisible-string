/**
 * `agent` step executor — lifecycle against fakes (no DB, no workers):
 *
 * - pure pieces: output extraction (result.completed vs stop-message,
 *   schema belt-and-braces), dispatch-error classification (the two
 *   retryable session-plane codes), origin mapping, thread-key reading;
 * - the child watch (terminal / waiting / missing / bus wake / abort);
 * - the executor itself through injected seams: fresh dispatch sends
 *   `mode:"task"` (+ outputSchema), the immediate `waiting` bounce links the
 *   child, re-attach extracts, thread steps resolve/claim the thread-keyed
 *   session, and failures classify per the plan's retry policy.
 */
import { describe, expect, test } from "bun:test";

import type {
  AgentStep,
  EveStreamEvent,
  OutputSchemaNode,
  TriggerEvent,
} from "@invisible-string/shared";

import { createLogger } from "../../log";
import { RunEventBus } from "../../runs/bus";
import { RuntimeApiError } from "../../runtime/errors";
import type {
  DispatchRenderedRunInput,
  DispatchRenderedRunResult,
} from "../../runtime/dispatch";
import type { ReadyAgentVersion, RuntimeDeps } from "../../runtime/routes";
import { createMemoryRunStore, makeRunRow } from "../test-support";
import type { PipelineScope } from "../types";
import type { StepExecuteContext } from "../types";
import {
  classifyAgentDispatchError,
  createAgentStepExecutor,
  extractAgentStepOutput,
  sessionOriginForTriggerType,
  slackThreadKeyFromTriggerData,
  watchChildRun,
  type ChildWatchIo,
} from "./agent";

const logger = createLogger({ sink: () => {}, minLevel: "error" });

function stopEvent(message: string): EveStreamEvent {
  return {
    type: "message.completed",
    data: { finishReason: "stop", message, sequence: 0, stepIndex: 0, turnId: "t0" },
  } as EveStreamEvent;
}

function resultEvent(result: unknown): EveStreamEvent {
  return {
    type: "result.completed",
    data: { result, sequence: 1, stepIndex: 0, turnId: "t0" },
  } as unknown as EveStreamEvent;
}

const SCHEMA: OutputSchemaNode = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
} as unknown as OutputSchemaNode;

// ── pure: output extraction ─────────────────────────────────────────────────

describe("extractAgentStepOutput", () => {
  test("schemaless: prefers the LAST result.completed", () => {
    const out = extractAgentStepOutput(
      [resultEvent({ a: 1 }), stopEvent("prose"), resultEvent({ a: 2 })],
      undefined,
    );
    expect(out).toEqual({ ok: true, output: { result: { a: 2 } } });
  });

  test("schemaless: falls back to the last stop-message text", () => {
    const out = extractAgentStepOutput([stopEvent("the reply")], undefined);
    expect(out).toEqual({ ok: true, output: { text: "the reply" } });
  });

  test("schema + valid result.completed → validated result", () => {
    const out = extractAgentStepOutput([resultEvent({ title: "hi" })], SCHEMA);
    expect(out).toEqual({ ok: true, output: { result: { title: "hi" } } });
  });

  test("schema + invalid result → validation_failed (belt-and-braces over eve)", () => {
    const out = extractAgentStepOutput([resultEvent({ nope: 1 })], SCHEMA);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorClass).toBe("validation_failed");
  });

  test("schema + no result but JSON stop-message → parse then validate", () => {
    const out = extractAgentStepOutput([stopEvent('{"title":"parsed"}')], SCHEMA);
    expect(out).toEqual({ ok: true, output: { result: { title: "parsed" } } });
  });

  test("schema + prose stop-message → validation_failed", () => {
    const out = extractAgentStepOutput([stopEvent("just words")], SCHEMA);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("not parseable as JSON");
  });

  test("schema + no output at all → validation_failed", () => {
    const out = extractAgentStepOutput([], SCHEMA);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorClass).toBe("validation_failed");
  });
});

// ── pure: classification + mapping ──────────────────────────────────────────

describe("classifyAgentDispatchError", () => {
  test("session_busy and session_not_active are RETRYABLE (fresh session on retry)", () => {
    for (const code of ["session_busy", "session_not_active"]) {
      const outcome = classifyAgentDispatchError(
        new RuntimeApiError(409, code, "nope"),
      );
      expect(outcome).toMatchObject({ status: "failed", errorClass: code, retryable: true });
    }
  });

  test("every other typed dispatch failure is permanent", () => {
    const outcome = classifyAgentDispatchError(
      new RuntimeApiError(409, "version_not_ready", "still building"),
    );
    expect(outcome).toMatchObject({ retryable: false, errorClass: "version_not_ready" });
  });

  test("unknown throws classify dispatch_failed, never retryable", () => {
    const outcome = classifyAgentDispatchError(new Error("socket hang up"));
    expect(outcome).toMatchObject({ errorClass: "dispatch_failed", retryable: false });
  });
});

describe("sessionOriginForTriggerType / slackThreadKeyFromTriggerData", () => {
  test("maps known trigger types; unknown → chat", () => {
    expect(sessionOriginForTriggerType("slack")).toBe("slack");
    expect(sessionOriginForTriggerType("schedule")).toBe("schedule");
    expect(sessionOriginForTriggerType("webhook")).toBe("webhook");
    expect(sessionOriginForTriggerType("form")).toBe("form");
    expect(sessionOriginForTriggerType("manual")).toBe("chat");
    expect(sessionOriginForTriggerType("pipeline")).toBe("chat");
  });

  test("reads the ingress-stamped thread key; null when absent/empty", () => {
    expect(slackThreadKeyFromTriggerData({ slackThreadKey: "i:c:t" })).toBe("i:c:t");
    expect(slackThreadKeyFromTriggerData({})).toBeNull();
    expect(slackThreadKeyFromTriggerData({ slackThreadKey: "" })).toBeNull();
    expect(slackThreadKeyFromTriggerData({ slackThreadKey: 42 })).toBeNull();
  });
});

// ── the child watch ─────────────────────────────────────────────────────────

function watchIo(overrides: Partial<ChildWatchIo> = {}): ChildWatchIo {
  return {
    getRunStatus: async () => ({ status: "succeeded", error: null }),
    subscribe: () => () => {},
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

describe("watchChildRun", () => {
  test("terminal / waiting / missing resolve immediately", async () => {
    const signal = new AbortController().signal;
    expect(await watchChildRun(watchIo(), "c1", signal, 5)).toEqual({
      kind: "terminal",
      status: "succeeded",
      error: null,
    });
    expect(
      await watchChildRun(
        watchIo({ getRunStatus: async () => ({ status: "waiting", error: null }) }),
        "c1",
        signal,
        5,
      ),
    ).toEqual({ kind: "waiting" });
    expect(
      await watchChildRun(watchIo({ getRunStatus: async () => null }), "c1", signal, 5),
    ).toEqual({ kind: "missing" });
  });

  test("wakes on a bus frame before the poll cadence", async () => {
    let status: "running" | "succeeded" = "running";
    let wake: (() => void) | null = null;
    const io = watchIo({
      getRunStatus: async () => ({ status, error: null }),
      subscribe: (_id, listener) => {
        wake = listener;
        return () => {};
      },
      sleep: () => new Promise(() => {}), // poll never fires — the bus must
    });
    const signal = new AbortController().signal;
    const watching = watchChildRun(io, "c1", signal, 60_000);
    await Bun.sleep(5);
    status = "succeeded";
    wake!();
    expect(await watching).toEqual({ kind: "terminal", status: "succeeded", error: null });
  });

  test("aborts promptly mid-wait", async () => {
    const controller = new AbortController();
    const io = watchIo({
      getRunStatus: async () => ({ status: "running", error: null }),
      sleep: () => new Promise(() => {}),
    });
    const watching = watchChildRun(io, "c1", controller.signal, 60_000);
    await Bun.sleep(5);
    controller.abort();
    expect(await watching).toEqual({ kind: "aborted" });
  });
});

// ── the executor against fakes ──────────────────────────────────────────────

const ORG = "org-agent-step";
const WORKFLOW = "7f1f9df2-4b7e-4b8e-9f5a-1c2d3e4f5a6b";
const AGENT_ID = "3f9a0d1e-2b3c-4d5e-8f90-a1b2c3d4e5f6";

function agentStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: "st_agentstep0000001",
    slug: "reply",
    kind: "agent",
    agentId: AGENT_ID,
    instructions: { markdown: "do the thing @trigger.x" },
    session: "fresh",
    ...overrides,
  };
}

function readyVersion(): ReadyAgentVersion {
  return {
    version: {
      id: "version-1",
      agentId: AGENT_ID,
      contentHash: "h".repeat(64),
      modelProvider: "openrouter",
      modelId: "test/model",
    },
    definition: {
      persona: "p",
      model: { preset: "balanced", reasoning: "medium" },
      context: { mcpConnectionIds: [], skillIds: [] },
    },
    artifactKey: "artifacts/x",
  } as unknown as ReadyAgentVersion;
}

function parentEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    workflowId: WORKFLOW,
    triggerType: "webhook",
    message: "",
    data: {},
    principal: { workspaceId: ORG, source: "webhook" },
    ...overrides,
  };
}

interface Harness {
  store: ReturnType<typeof createMemoryRunStore>;
  bus: RunEventBus;
  runtimeDeps: RuntimeDeps;
  dispatches: DispatchRenderedRunInput[];
  ctx(step: AgentStep, opts?: {
    input?: unknown;
    childRunId?: string;
    trigger?: Record<string, unknown>;
    signal?: AbortSignal;
  }): StepExecuteContext;
}

function harness(): Harness {
  const store = createMemoryRunStore();
  const bus = new RunEventBus();
  const runtimeDeps = {
    runStore: store,
    bus,
    logger,
  } as unknown as RuntimeDeps;
  const dispatches: DispatchRenderedRunInput[] = [];
  return {
    store,
    bus,
    runtimeDeps,
    dispatches,
    ctx(step, opts = {}) {
      const scope: PipelineScope = {
        trigger: opts.trigger ?? {},
        steps: {},
        state: {},
        now: new Date().toISOString(),
      };
      return {
        deps: {
          db: {} as never,
          logger,
          masterKey: undefined,
          fetchImpl: fetch,
          runtimeDeps,
        },
        orgId: ORG,
        run: { id: "parent-run", workflowId: WORKFLOW },
        step,
        input: opts.input ?? { instructions: "do the thing rendered" },
        scope,
        signal: opts.signal ?? new AbortController().signal,
        attempt: 1,
        path: step.id,
        ...(opts.childRunId ? { childRunId: opts.childRunId } : {}),
      };
    },
  };
}

function fakeDispatch(
  h: Harness,
  result?: Partial<DispatchRenderedRunResult>,
): (deps: RuntimeDeps, input: DispatchRenderedRunInput) => Promise<DispatchRenderedRunResult> {
  return async (_deps, input) => {
    h.dispatches.push(input);
    const run = makeRunRow({
      id: "child-run-1",
      mode: "agent",
      agentSessionId: "session-1",
      workflowId: WORKFLOW,
      status: "queued",
    });
    h.store.setStatus(run.id, "queued");
    return {
      session: { id: "session-1" } as never,
      run,
      dispatched: true,
      ...result,
    };
  };
}

describe("agent step executor (fresh sessions)", () => {
  test("dispatches TASK mode (+outputSchema), then parks immediately so the runner links the child", async () => {
    const h = harness();
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const step = agentStep({ output: { schema: SCHEMA } });
    const outcome = await executor(h.ctx(step));
    expect(outcome).toEqual({ status: "waiting", childRunId: "child-run-1" });
    expect(h.dispatches).toHaveLength(1);
    const dispatched = h.dispatches[0]!;
    expect(dispatched.taskMessage).toBe("do the thing rendered");
    expect(dispatched.workflowId).toBe(WORKFLOW);
    expect(dispatched.origin).toBe("webhook"); // mapped from the parent's type
    expect(dispatched.triggerType).toBe("pipeline");
    expect(dispatched.eveCreate).toEqual({
      mode: "task",
      outputSchema: SCHEMA as unknown as Record<string, unknown>,
    });
    // Child provenance names the REAL agent + the parent step instance.
    expect(dispatched.triggerEvent.agentId).toBe(AGENT_ID);
    expect(dispatched.triggerEvent.data).toMatchObject({
      parentRunId: "parent-run",
      stepId: step.id,
    });
  });

  test("no declared schema ⇒ mode:task alone (no outputSchema key)", async () => {
    const h = harness();
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    await executor(h.ctx(agentStep()));
    expect(h.dispatches[0]!.eveCreate).toEqual({ mode: "task" });
  });

  test("re-attached with childRunId: waits for the terminal and extracts the validated result", async () => {
    const h = harness();
    h.store.setStatus("child-run-1", "succeeded");
    await h.store.appendEvent("child-run-1", 0, stopEvent("prose"));
    await h.store.appendEvent("child-run-1", 1, resultEvent({ title: "done" }));
    const executor = createAgentStepExecutor({ pollMs: 5 });
    const outcome = await executor(
      h.ctx(agentStep({ output: { schema: SCHEMA } }), { childRunId: "child-run-1" }),
    );
    expect(outcome).toEqual({
      status: "succeeded",
      output: { result: { title: "done" } },
    });
  });

  test("a child that parks waiting parks the step (runner re-invokes later)", async () => {
    const h = harness();
    h.store.setStatus("child-run-1", "waiting");
    const executor = createAgentStepExecutor({ pollMs: 5 });
    const outcome = await executor(h.ctx(agentStep(), { childRunId: "child-run-1" }));
    expect(outcome).toEqual({ status: "waiting", childRunId: "child-run-1" });
  });

  test("a FAILED child turn is a permanent step failure (never retried)", async () => {
    const h = harness();
    h.store.setStatus("child-run-1", "failed", "model exploded");
    const executor = createAgentStepExecutor({ pollMs: 5 });
    const outcome = await executor(h.ctx(agentStep(), { childRunId: "child-run-1" }));
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "agent_run_failed",
      retryable: false,
    });
  });

  test("a vanished child run fails child_run_missing", async () => {
    const h = harness();
    const executor = createAgentStepExecutor({ pollMs: 5 });
    const outcome = await executor(h.ctx(agentStep(), { childRunId: "ghost" }));
    expect(outcome).toMatchObject({ status: "failed", errorClass: "child_run_missing" });
  });

  test("an unbound agent step fails agent_not_bound", async () => {
    const h = harness();
    const executor = createAgentStepExecutor({ pollMs: 5, dispatchImpl: fakeDispatch(h) });
    const outcome = await executor(h.ctx(agentStep({ agentId: null })));
    expect(outcome).toMatchObject({ status: "failed", errorClass: "agent_not_bound" });
    expect(h.dispatches).toHaveLength(0);
  });

  test("dispatched:false (allowlist pre-flight) fails model_disallowed_at_dispatch", async () => {
    const h = harness();
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: async (_deps, input) => {
        h.dispatches.push(input);
        return {
          session: { id: "session-1" } as never,
          run: makeRunRow({ id: "child-run-1", status: "failed", error: "model x is no longer on this workspace's allowlist" }),
          dispatched: false,
        };
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(h.ctx(agentStep()));
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "model_disallowed_at_dispatch",
      retryable: false,
    });
  });

  test("dispatch throws session_busy ⇒ retryable failure (the runner backs off)", async () => {
    const h = harness();
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: async () => {
        throw new RuntimeApiError(409, "session_busy", "already running");
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(h.ctx(agentStep()));
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "session_busy",
      retryable: true,
    });
  });
});

describe("agent step executor (thread sessions)", () => {
  const THREAD_KEY = "integ-1:C1:1720.0";

  test("continues the EXISTING thread session on its PINNED version, no task mode", async () => {
    const h = harness();
    const existing = { id: "sess-thread", agentVersionId: "pinned-v" } as never;
    let pinnedAsked = "";
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      findThreadSessionImpl: async () => existing,
      requireReadyVersionImpl: async (_deps, versionId) => {
        pinnedAsked = versionId;
        return readyVersion();
      },
      loadParentTriggerEventImpl: async () =>
        parentEvent({ triggerType: "slack", data: { slackThreadKey: THREAD_KEY } }),
    });
    const outcome = await executor(
      h.ctx(agentStep({ session: "thread" }), {
        trigger: { slackThreadKey: THREAD_KEY },
      }),
    );
    expect(outcome).toEqual({ status: "waiting", childRunId: "child-run-1" });
    expect(pinnedAsked).toBe("pinned-v");
    const dispatched = h.dispatches[0]!;
    expect(dispatched.existingSession).toBe(existing);
    expect(dispatched.eveCreate).toBeUndefined();
    expect(dispatched.origin).toBe("slack");
    expect(dispatched.newSessionSlackThreadKey).toBeUndefined();
  });

  test("no session yet: claims the thread key on the agent's CURRENT version", async () => {
    const h = harness();
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      findThreadSessionImpl: async () => null,
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () =>
        parentEvent({ triggerType: "slack", data: { slackThreadKey: THREAD_KEY } }),
    });
    const outcome = await executor(
      h.ctx(agentStep({ session: "thread" }), {
        trigger: { slackThreadKey: THREAD_KEY },
      }),
    );
    expect(outcome).toEqual({ status: "waiting", childRunId: "child-run-1" });
    const dispatched = h.dispatches[0]!;
    expect(dispatched.newSessionSlackThreadKey).toBe(THREAD_KEY);
    expect(dispatched.sessionPrincipalExtra).toEqual({ slackThreadKey: THREAD_KEY });
    expect(dispatched.eveCreate).toBeUndefined(); // conversational — answerable
  });

  test("a thread step on a non-slack run fails thread_key_missing", async () => {
    const h = harness();
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(h.ctx(agentStep({ session: "thread" })));
    expect(outcome).toMatchObject({ status: "failed", errorClass: "thread_key_missing" });
    expect(h.dispatches).toHaveLength(0);
  });
});
