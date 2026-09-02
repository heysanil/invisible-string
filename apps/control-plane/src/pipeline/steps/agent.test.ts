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

import type { DbClient } from "../../db";
import { createLogger } from "../../log";
import { RunEventBus } from "../../runs/bus";
import { parseSlackThreadKey } from "../../runs/delivery";
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
  agentQualifiedThreadKey,
  classifyAgentDispatchError,
  createAgentStepExecutor,
  extractAgentStepOutput,
  linkChildRunToStep,
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

/**
 * Chainable drizzle-shaped tx stub, so the DEFAULT `linkChildRunToStep` and
 * the link hook's DEFAULT parent-status re-read both survive fake dispatches
 * that mirror the real hook invocation. The select chain answers the parent
 * run's status (`"running"` unless overridden — the live-parent case).
 */
function fakeTx(
  returningRows: Array<{ id: string }> = [{ id: "rs_row" }],
  parentStatus: string | null = "running",
): DbClient {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (parentStatus === null ? [] : [{ status: parentStatus }]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => returningRows }),
      }),
    }),
  } as unknown as DbClient;
}

function fakeDispatch(
  h: Harness,
  result?: Partial<DispatchRenderedRunResult>,
  opts: { tx?: DbClient; beforeHook?: () => void; afterHook?: () => void } = {},
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
    // Mirror the real dispatch: the run-creation TRANSACTION invokes
    // onRunCreated after inserting the run row, strictly before any eve
    // call — the executor's child linkage must ride it.
    opts.beforeHook?.();
    await input.onRunCreated?.(opts.tx ?? fakeTx(), run);
    opts.afterHook?.();
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

// ── F1: pre-dispatch child linkage (crash-window double-dispatch guard) ─────

describe("agent step child linkage (in-transaction, pre-dispatch)", () => {
  test("dispatch carries onRunCreated, which links the ledger row (run id + path → child id) inside the tx", async () => {
    const h = harness();
    const links: Array<{
      tx: DbClient;
      parentRunId: string;
      path: string;
      childRunId: string;
    }> = [];
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      linkChildRunImpl: async (tx, parentRunId, path, childRunId) => {
        links.push({ tx, parentRunId, path, childRunId });
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const step = agentStep();
    const outcome = await executor(h.ctx(step));
    expect(outcome).toEqual({ status: "waiting", childRunId: "child-run-1" });
    // Linked BY the dispatch's transaction hook — before dispatch even
    // returned, i.e. before any crash window after the eve call can open.
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      parentRunId: "parent-run",
      path: step.id,
      childRunId: "child-run-1",
    });
  });

  test("thread continuations link the child the same way", async () => {
    const h = harness();
    const links: string[] = [];
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      linkChildRunImpl: async (_tx, _parentRunId, _path, childRunId) => {
        links.push(childRunId);
      },
      findThreadSessionImpl: async () =>
        ({ id: "sess-thread", agentId: AGENT_ID, agentVersionId: "pinned-v" }) as never,
      requireReadyVersionImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () =>
        parentEvent({ triggerType: "slack", data: { slackThreadKey: "i:c:t" } }),
    });
    const outcome = await executor(
      h.ctx(agentStep({ session: "thread" }), { trigger: { slackThreadKey: "i:c:t" } }),
    );
    expect(outcome).toEqual({ status: "waiting", childRunId: "child-run-1" });
    expect(links).toEqual(["child-run-1"]);
  });

  test("a linkage failure aborts the dispatch (classified, never a silent unlinked child)", async () => {
    const h = harness();
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      linkChildRunImpl: async () => {
        throw new Error("no claimed run_steps row");
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(h.ctx(agentStep()));
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "dispatch_failed",
      retryable: false,
    });
  });
});

describe("linkChildRunToStep", () => {
  test("writes childRunId onto the claimed row", async () => {
    const sets: unknown[] = [];
    const tx = {
      update: () => ({
        set: (patch: unknown) => {
          sets.push(patch);
          return { where: () => ({ returning: async () => [{ id: "rs_1" }] }) };
        },
      }),
    } as unknown as DbClient;
    await linkChildRunToStep(tx, "run-1", "st_a", "child-9");
    expect(sets).toEqual([{ childRunId: "child-9" }]);
  });

  test("throws (aborting the dispatch tx) when no ledger row matches the claim key", async () => {
    await expect(
      linkChildRunToStep(fakeTx([]), "run-1", "st_a", "child-9"),
    ).rejects.toThrow(/no claimed run_steps row/);
  });
});

describe("agent step executor (thread sessions)", () => {
  const THREAD_KEY = "integ-1:C1:1720.0";

  test("continues the EXISTING bare-key thread session on its PINNED version (agent match), no task mode", async () => {
    const h = harness();
    // The holder's agent matches the step's binding — the reuse condition.
    // Key-aware fake: the session holds the BARE key only, so the executor's
    // qualified-first probe misses and the bare fallback reuses it.
    const existing = {
      id: "sess-thread",
      agentId: AGENT_ID,
      agentVersionId: "pinned-v",
    } as never;
    const lookups: string[] = [];
    let pinnedAsked = "";
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      findThreadSessionImpl: async (_db, _org, _wf, key) => {
        lookups.push(key);
        return key === THREAD_KEY ? existing : null;
      },
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
    expect(lookups).toEqual([
      agentQualifiedThreadKey(THREAD_KEY, AGENT_ID),
      THREAD_KEY,
    ]);
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

  // ── F2: a thread claimed by a DIFFERENT agent is never reused ────────────

  test("agent mismatch: the holder's session is NOT reused — the claim moves to the agent-qualified key", async () => {
    const h = harness();
    const lookups: string[] = [];
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      findThreadSessionImpl: async (_db, _org, _wf, key) => {
        lookups.push(key);
        // The bare key is held by ANOTHER agent's session; nothing holds
        // this agent's qualified key yet.
        return key === THREAD_KEY
          ? ({
              id: "sess-other-agent",
              agentId: "11111111-2222-3333-4444-555555555555",
              agentVersionId: "other-pinned-v",
            } as never)
          : null;
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      requireReadyVersionImpl: async () => {
        throw new Error("must never run the mismatched holder's pinned version");
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
    const qualified = agentQualifiedThreadKey(THREAD_KEY, AGENT_ID);
    // QUALIFIED-FIRST: the step's own derivative claim is probed before the
    // bare ingress key.
    expect(lookups).toEqual([qualified, THREAD_KEY]);
    const dispatched = h.dispatches[0]!;
    // The step runs on ITS agent's CURRENT version, in a fresh session
    // claimed under the qualified key (unique index respected)…
    expect(dispatched.existingSession).toBeUndefined();
    expect(dispatched.newSessionSlackThreadKey).toBe(qualified);
    // …while the principal keeps the BARE key — the session's true Slack
    // thread identity.
    expect(dispatched.sessionPrincipalExtra).toEqual({ slackThreadKey: THREAD_KEY });
    expect(dispatched.origin).toBe("slack");
    expect(dispatched.eveCreate).toBeUndefined();
  });

  test("agent mismatch with an established qualified session: continues IT on its pinned version", async () => {
    const h = harness();
    const qualified = agentQualifiedThreadKey(THREAD_KEY, AGENT_ID);
    const ownSession = {
      id: "sess-own-agent",
      agentId: AGENT_ID,
      agentVersionId: "own-pinned-v",
    } as never;
    let pinnedAsked = "";
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      findThreadSessionImpl: async (_db, _org, _wf, key) =>
        key === THREAD_KEY
          ? ({ id: "sess-other-agent", agentId: "not-this-agent" } as never)
          : key === qualified
            ? ownSession
            : null,
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
    expect(pinnedAsked).toBe("own-pinned-v");
    const dispatched = h.dispatches[0]!;
    expect(dispatched.existingSession).toBe(ownSession);
    expect(dispatched.newSessionSlackThreadKey).toBeUndefined();
  });

  // ── F2: a terminated bare holder must not strand the qualified session ───

  test("terminated bare holder: the step's own QUALIFIED session is found FIRST and continued (no fresh bare session)", async () => {
    const h = harness();
    const qualified = agentQualifiedThreadKey(THREAD_KEY, AGENT_ID);
    const ownSession = {
      id: "sess-own-agent",
      agentId: AGENT_ID,
      agentVersionId: "own-pinned-v",
    } as never;
    const lookups: string[] = [];
    let pinnedAsked = "";
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      findThreadSessionImpl: async (_db, _org, _wf, key) => {
        lookups.push(key);
        // The bare holder TERMINATED and released its claim (returns null);
        // only the qualified session survives. The old bare-key-first
        // lookup found nothing and minted a NEW bare session, stranding the
        // qualified session's history.
        return key === qualified ? ownSession : null;
      },
      requireReadyVersionImpl: async (_deps, versionId) => {
        pinnedAsked = versionId;
        return readyVersion();
      },
      resolveReadyAgentImpl: async () => {
        throw new Error("must continue the qualified session, not mint a new one");
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
    expect(lookups).toEqual([qualified]); // qualified hit — bare never consulted
    expect(pinnedAsked).toBe("own-pinned-v");
    const dispatched = h.dispatches[0]!;
    expect(dispatched.existingSession).toBe(ownSession);
    expect(dispatched.newSessionSlackThreadKey).toBeUndefined();
  });

  test("agentQualifiedThreadKey can never parse as a bare Slack reply key (delivery safety)", () => {
    const key = agentQualifiedThreadKey(THREAD_KEY, AGENT_ID);
    expect(key).toBe(`${THREAD_KEY}:agent:${AGENT_ID}`);
    // parseSlackThreadKey requires exactly three `:`-segments — a qualified
    // key must fail loudly rather than silently mis-target a channel/ts.
    expect(parseSlackThreadKey(key)).toBeNull();
    expect(parseSlackThreadKey(THREAD_KEY)).not.toBeNull();
  });
});

// ── NEW-1: Stop racing the dispatch (both fences) ───────────────────────────

describe("agent step cancel fences", () => {
  test("fence (a): signal aborted before the link hook → transaction aborted, NO child linked, NO dispatch survives", async () => {
    const h = harness();
    const controller = new AbortController();
    const links: string[] = [];
    const cancels: string[] = [];
    const executor = createAgentStepExecutor({
      pollMs: 5,
      // The Stop lands while the dispatch transaction is open, before the
      // hook runs — the hook must throw, aborting the transaction.
      dispatchImpl: fakeDispatch(h, undefined, {
        beforeHook: () => controller.abort(),
      }),
      linkChildRunImpl: async (_tx, _run, _path, childRunId) => {
        links.push(childRunId);
      },
      cancelChildRunImpl: async (_deps, childRunId) => {
        cancels.push(childRunId);
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(
      h.ctx(agentStep(), { signal: controller.signal }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "canceled",
      retryable: false,
    });
    expect(links).toEqual([]); // the transaction aborted — no link, no child
    expect(cancels).toEqual([]); // nothing dispatched — nothing to chase
  });

  test("fence (a): a parent already settled canceled aborts the link hook the same way", async () => {
    const h = harness();
    const links: string[] = [];
    const executor = createAgentStepExecutor({
      pollMs: 5,
      // The route's direct CAS (no live driver) settled the parent before
      // the hook's in-transaction re-read.
      dispatchImpl: fakeDispatch(h, undefined, {
        tx: fakeTx([{ id: "rs_row" }], "canceled"),
      }),
      linkChildRunImpl: async (_tx, _run, _path, childRunId) => {
        links.push(childRunId);
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(h.ctx(agentStep()));
    expect(outcome).toMatchObject({ status: "failed", errorClass: "canceled" });
    expect(links).toEqual([]);
  });

  test("fence (b): Stop lands AFTER the link — the just-dispatched child is canceled through the cancel path", async () => {
    const h = harness();
    const controller = new AbortController();
    const links: string[] = [];
    const cancels: Array<{ childRunId: string; reason: string }> = [];
    const executor = createAgentStepExecutor({
      pollMs: 5,
      // The link committed and the eve call went out; the Stop lands before
      // the dispatch returns (the runner has abandoned this promise — the
      // executor itself must chase the child).
      dispatchImpl: fakeDispatch(h, undefined, {
        afterHook: () => controller.abort(),
      }),
      linkChildRunImpl: async (_tx, _run, _path, childRunId) => {
        links.push(childRunId);
      },
      cancelChildRunImpl: async (_deps, childRunId, reason) => {
        cancels.push({ childRunId, reason });
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(
      h.ctx(agentStep(), { signal: controller.signal }),
    );
    expect(outcome).toMatchObject({ status: "failed", errorClass: "canceled" });
    expect(links).toEqual(["child-run-1"]); // linked before the Stop
    expect(cancels).toHaveLength(1); // …so the child is chased, not orphaned
    expect(cancels[0]!.childRunId).toBe("child-run-1");
  });

  test("fence (b): a parent row settled canceled mid-dispatch is caught by the status re-check too", async () => {
    const h = harness();
    const cancels: string[] = [];
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h, undefined, {
        // The cancel route CAS'd the parent while the eve call was in
        // flight — no signal abort reached this executor (no live driver).
        afterHook: () => h.store.setStatus("parent-run", "canceled"),
      }),
      cancelChildRunImpl: async (_deps, childRunId) => {
        cancels.push(childRunId);
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(h.ctx(agentStep()));
    expect(outcome).toMatchObject({ status: "failed", errorClass: "canceled" });
    expect(cancels).toEqual(["child-run-1"]);
  });

  test("the dispatch's own pre-eve fence (canceledBeforeDispatch) classifies canceled and chases nothing", async () => {
    const h = harness();
    const cancels: string[] = [];
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: async (_deps, input) => {
        h.dispatches.push(input);
        return {
          session: { id: "session-1" } as never,
          run: makeRunRow({ id: "child-run-1", status: "canceled" }),
          dispatched: false,
          canceledBeforeDispatch: true,
        };
      },
      cancelChildRunImpl: async (_deps, childRunId) => {
        cancels.push(childRunId);
      },
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(h.ctx(agentStep()));
    expect(outcome).toMatchObject({ status: "failed", errorClass: "canceled" });
    expect(cancels).toEqual([]); // nothing reached eve — nothing to cancel
  });
});

// ── F1: stillborn-child recovery (crash before the eve create) ──────────────

describe("agent step stillborn-child recovery", () => {
  test("a failed child that PROVABLY never dispatched (no marker, no eve id) is replaced by a fresh dispatch", async () => {
    const h = harness();
    // Boot reconciliation swept the crashed child to `failed`; the
    // dispatch-attempt marker was never written and no eve session exists.
    h.store.setStatus("stillborn-child", "failed", "control plane restarted");
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      loadChildDispatchStateImpl: async () => ({
        status: "failed",
        startedAt: null,
        eveSessionId: null,
        sessionId: "stillborn-session",
      }),
      resolveReadyAgentImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () => parentEvent(),
    });
    const outcome = await executor(
      h.ctx(agentStep(), { childRunId: "stillborn-child" }),
    );
    // Phase 1 ran again: a REPLACEMENT child was dispatched and the step
    // parks on it (the link hook overwrote child_run_id).
    expect(outcome).toEqual({ status: "waiting", childRunId: "child-run-1" });
    expect(h.dispatches).toHaveLength(1);
    // The stillborn's session was closed (releases any thread-key claim).
    expect(h.store.sessionMarks).toEqual([
      { sessionId: "stillborn-session", status: "error" },
    ]);
  });

  test("a failed child WITH the dispatch-attempt marker fails honest (may have reached eve — never re-dispatch)", async () => {
    const h = harness();
    h.store.setStatus("child-x", "failed", "control plane restarted");
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      loadChildDispatchStateImpl: async () => ({
        status: "failed",
        startedAt: new Date(), // marker written — the create MAY have been issued
        eveSessionId: null,
        sessionId: "sess-x",
      }),
    });
    const outcome = await executor(h.ctx(agentStep(), { childRunId: "child-x" }));
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "agent_run_failed",
      retryable: false,
    });
    expect(h.dispatches).toHaveLength(0); // NEVER a second dispatch
    expect(h.store.sessionMarks).toEqual([]);
  });

  test("a failed child with the marker AND a persisted eve session id fails honest too", async () => {
    const h = harness();
    h.store.setStatus("child-y", "failed", "model exploded");
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      loadChildDispatchStateImpl: async () => ({
        status: "failed",
        startedAt: new Date(),
        eveSessionId: "eve-123",
        sessionId: "sess-y",
      }),
    });
    const outcome = await executor(h.ctx(agentStep(), { childRunId: "child-y" }));
    expect(outcome).toMatchObject({ status: "failed", errorClass: "agent_run_failed" });
    expect(h.dispatches).toHaveLength(0);
  });

  test("a stillborn THREAD CONTINUATION (marker null, session's eve id from earlier turns) re-sends the continuation ONCE — session left open", async () => {
    const THREAD_KEY = "integ-1:C1:1720.0";
    const h = harness();
    // Crash between the run insert and the continue-send: boot
    // reconciliation failed the child (marker null). The session is an
    // ESTABLISHED thread session — it has an eve id from earlier turns.
    h.store.setStatus("stillborn-cont", "failed", "control plane restarted before the run's message was sent");
    const existing = {
      id: "sess-thread",
      agentId: AGENT_ID,
      agentVersionId: "pinned-v",
      eveSessionId: "eve-established",
    } as never;
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      loadChildDispatchStateImpl: async () => ({
        status: "failed",
        startedAt: null, // the marker was never written — the send never left
        eveSessionId: "eve-established", // earlier turns', NOT this run's
        sessionId: "sess-thread",
      }),
      findThreadSessionImpl: async (_db, _org, _wf, key) =>
        key === THREAD_KEY ? existing : null,
      requireReadyVersionImpl: async () => readyVersion(),
      loadParentTriggerEventImpl: async () =>
        parentEvent({ triggerType: "slack", data: { slackThreadKey: THREAD_KEY } }),
    });
    const outcome = await executor(
      h.ctx(agentStep({ session: "thread" }), {
        childRunId: "stillborn-cont",
        trigger: { slackThreadKey: THREAD_KEY },
      }),
    );
    // Exactly ONE replacement dispatch, and it CONTINUES the established
    // session (the message never left, so re-sending cannot double-send).
    expect(outcome).toEqual({ status: "waiting", childRunId: "child-run-1" });
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]!.existingSession).toBe(existing);
    // The continuation's session was NOT closed — closing it would strand
    // the thread's history (only eveless stillborn sessions are closed).
    expect(h.store.sessionMarks).toEqual([]);
  });

  test("an unknowable dispatch state (no db on the deps graph) fails honest — fail-safe, never re-dispatch", async () => {
    const h = harness();
    h.store.setStatus("child-z", "failed", "restarted");
    // DEFAULT loader: the harness deps carry no db → null → not provably
    // undispatched.
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
    });
    const outcome = await executor(h.ctx(agentStep(), { childRunId: "child-z" }));
    expect(outcome).toMatchObject({ status: "failed", errorClass: "agent_run_failed" });
    expect(h.dispatches).toHaveLength(0);
  });

  test("a CANCELED child is never resurrected by the stillborn probe", async () => {
    const h = harness();
    h.store.setStatus("child-c", "canceled", "user stopped it");
    const executor = createAgentStepExecutor({
      pollMs: 5,
      dispatchImpl: fakeDispatch(h),
      loadChildDispatchStateImpl: async () => ({
        status: "canceled",
        startedAt: null,
        eveSessionId: null,
        sessionId: "sess-c",
      }),
    });
    const outcome = await executor(h.ctx(agentStep(), { childRunId: "child-c" }));
    expect(outcome).toMatchObject({ status: "failed", errorClass: "agent_run_canceled" });
    expect(h.dispatches).toHaveLength(0);
  });
});
