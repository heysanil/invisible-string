/**
 * Live-plumbing tests for useThreadStreams: frame delivery folds into per-run
 * stores, run_status frames bubble to onRunStatus, and re-attaching a stream
 * (HITL resume) reuses the seq cursor so replayed frames dedupe.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type {
  RunEventFrame,
  RunStatus,
  RunStatusFrame,
} from "@invisible-string/shared";
import type {
  RunStreamHandlers,
  RunStreamHandle,
  RunStreamOptions,
} from "../lib/sse";
import { useThreadStreams } from "../lib/chat/use-thread-streams";

ensureDomForThisFile();
// Drain a macrotask after unmount so React's scheduler flushes its pending
// work while happy-dom is still registered (cross-file teardown race).
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** A controllable fake stream: capture handlers + the resume cursor per open. */
interface FakeStream {
  handlers: RunStreamHandlers;
  options: RunStreamOptions;
  closed: boolean;
}

function makeFakeStreamFn() {
  const opens: FakeStream[] = [];
  const streamFn = ((_runId: string, handlers: RunStreamHandlers, options: RunStreamOptions = {}): RunStreamHandle => {
    const entry: FakeStream = { handlers, options, closed: false };
    opens.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
      get state() {
        return "open" as const;
      },
      get lastEventId() {
        return null;
      },
    };
  }) as typeof import("../lib/sse").streamRun;
  return { streamFn, opens };
}

function eventFrame(runId: string, seq: number): RunEventFrame {
  return {
    runId,
    seq,
    event: { type: "turn.started", data: { sequence: seq, turnId: "t" } },
    at: new Date(seq * 1000).toISOString(),
  };
}

function statusFrame(runId: string, status: RunStatus): RunStatusFrame {
  return { runId, status };
}

// TEMP DIAGNOSTICS (CI-runner-only failure) — remove before merge.
test("DIAG environment probe", async () => {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  console.log(
    "DIAG dom-registered:", GlobalRegistrator.isRegistered,
    "| act-env:", globalThis.IS_REACT_ACT_ENVIRONMENT,
    "| window:", typeof window,
    "| document:", typeof document,
  );
  await new Promise<void>((resolve) => {
    const mc = new MessageChannel();
    const t = setTimeout(() => {
      console.log("DIAG message-channel: NEVER FIRED (500ms)");
      resolve();
    }, 500);
    mc.port1.onmessage = () => {
      clearTimeout(t);
      console.log("DIAG message-channel: fired");
      resolve();
    };
    mc.port2.postMessage(1);
  });
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      console.log("DIAG setTimeout(0): fired");
      resolve();
    }, 0),
  );
  const { streamFn, opens } = makeFakeStreamFn();
  const { result } = renderHook(() =>
    useThreadStreams([{ id: "diag", status: "running" as RunStatus }], { streamFn }),
  );
  console.log("DIAG opens immediately after renderHook:", opens.length);
  const { act } = await import("@testing-library/react");
  await act(async () => {});
  console.log("DIAG opens after explicit act flush:", opens.length);
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log(
    "DIAG opens after 150ms:", opens.length,
    "| state entries:", result.current.runs.size,
  );
  const entry = result.current.runs.get("diag");
  console.log(
    "DIAG state entry:",
    JSON.stringify(
      entry
        ? {
            status: entry.status,
            error: entry.error,
            streamError: entry.streamError,
            frames: entry.store.frames.length,
          }
        : null,
    ),
  );
  console.log(
    "DIAG react version:", (await import("react")).version,
    "| NODE_ENV:", process.env.NODE_ENV,
  );
});

test("frames fold into the run's store; status frames bubble to onRunStatus", async () => {
  const { streamFn, opens } = makeFakeStreamFn();
  const onRunStatus = mock((_runId: string, _status: RunStatus) => {});
  const runs = [{ id: "run1", status: "running" as RunStatus }];

  const { result } = renderHook(() =>
    useThreadStreams(runs, { streamFn, onRunStatus }),
  );

  await waitFor(() => expect(opens.length).toBe(1));
  const stream = opens[0]!;

  act(() => {
    stream.handlers.onRunEvent?.(eventFrame("run1", 0));
    stream.handlers.onRunEvent?.(eventFrame("run1", 1));
    stream.handlers.onRunStatus?.(statusFrame("run1", "waiting"));
  });

  await waitFor(() => {
    const live = result.current.runs.get("run1");
    expect(live?.store.frames.length).toBe(2);
  });
  const live = result.current.runs.get("run1")!;
  expect(live.store.maxSeq).toBe(1);
  expect(live.status).toBe("waiting");
  expect(onRunStatus).toHaveBeenCalledWith("run1", "waiting");
});

test("reopen resumes from the seq cursor and replayed frames dedupe", async () => {
  const { streamFn, opens } = makeFakeStreamFn();
  const runs = [{ id: "run1", status: "running" as RunStatus }];
  const { result } = renderHook(() => useThreadStreams(runs, { streamFn }));

  await waitFor(() => expect(opens.length).toBe(1));
  act(() => {
    opens[0]!.handlers.onRunEvent?.(eventFrame("run1", 0));
    opens[0]!.handlers.onRunEvent?.(eventFrame("run1", 1));
  });
  await waitFor(() =>
    expect(result.current.runs.get("run1")?.store.maxSeq).toBe(1),
  );

  // Re-attach the stream (as after answering a HITL input).
  act(() => {
    result.current.reopen("run1");
  });
  await waitFor(() => expect(opens.length).toBe(2));
  // The new connection resumes from the last seq (1).
  expect(opens[0]!.closed).toBe(true);
  expect(opens[1]!.options.lastEventId).toBe(1);

  // Server replays seq 1 (inclusive of cursor edge) then delivers seq 2.
  act(() => {
    opens[1]!.handlers.onRunEvent?.(eventFrame("run1", 1));
    opens[1]!.handlers.onRunEvent?.(eventFrame("run1", 2));
  });
  await waitFor(() =>
    expect(result.current.runs.get("run1")?.store.maxSeq).toBe(2),
  );
  // No duplicate: exactly 3 frames (0,1,2) despite the replayed 1.
  expect(result.current.runs.get("run1")!.store.frames.map((f) => f.seq)).toEqual([
    0, 1, 2,
  ]);
});

test("streams close for runs that leave the thread", async () => {
  const { streamFn, opens } = makeFakeStreamFn();
  let runs = [
    { id: "run1", status: "succeeded" as RunStatus },
    { id: "run2", status: "running" as RunStatus },
  ];
  const { result, rerender } = renderHook(
    ({ list }) => useThreadStreams(list, { streamFn }),
    { initialProps: { list: runs } },
  );
  await waitFor(() => expect(opens.length).toBe(2));

  // Drop run2 from the thread.
  runs = [{ id: "run1", status: "succeeded" as RunStatus }];
  rerender({ list: runs });

  await waitFor(() => {
    // run2's stream was closed; run1's stays open.
    expect(opens[1]!.closed).toBe(true);
    expect(opens[0]!.closed).toBe(false);
  });
  void result;
});
