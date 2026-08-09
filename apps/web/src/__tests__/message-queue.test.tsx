/**
 * The message queue's flush state machine, driven without a DOM composer.
 *
 * Every case here targets a concurrency hole rather than a happy path: the
 * queue's whole job is to serialize behind a slot whose state the client only
 * ever learns about a beat late, so the interesting behavior lives in the gaps
 * — enqueueing mid-flight, a retry armed while the slot is free, and the
 * difference between the two 409s.
 *
 * `retryDelayMs` is injected because bun:test has no fake timers.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { ApiError } from "../lib/api-client";
import { mergeQueued, useMessageQueue } from "../lib/chat/use-message-queue";

ensureDomForThisFile();
afterEach(cleanup);

function busyError(): ApiError {
  return new ApiError(409, "session_busy", "This session is still working.");
}

function deadError(): ApiError {
  return new ApiError(409, "session_not_active", "This session is retired.");
}

/** Renders the hook with overridable options and a settled-promise `send`. */
function setup(overrides: Partial<Parameters<typeof useMessageQueue>[0]> = {}) {
  const send = mock((_text: string) => Promise.resolve());
  const onGiveUp = mock((_text: string) => {});
  const onRetired = mock(() => {});
  const view = renderHook(
    ({ canFlush }: { canFlush: boolean }) =>
      useMessageQueue({
        canFlush,
        send,
        onGiveUp,
        onRetired,
        retryDelayMs: 5,
        ...overrides,
      }),
    { initialProps: { canFlush: false } },
  );
  return { ...view, send, onGiveUp, onRetired };
}

test("queued messages merge into one send, separated by a blank line", async () => {
  const { result, rerender, send } = setup();

  act(() => {
    result.current.enqueue("add tests");
    result.current.enqueue("then push");
  });
  expect(result.current.queued.map((m) => m.text)).toEqual([
    "add tests",
    "then push",
  ]);
  // Nothing goes out while the slot is held.
  expect(send).not.toHaveBeenCalled();

  rerender({ canFlush: true });

  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]?.[0]).toBe("add tests\n\nthen push");
  await waitFor(() => expect(result.current.queued).toHaveLength(0));
});

test("enqueueing while free flushes immediately — the trigger is the condition, not an edge", async () => {
  const { result, rerender, send } = setup();
  // canFlush is ALREADY true before anything is queued: an edge-triggered
  // machine would strand this message forever.
  rerender({ canFlush: true });

  act(() => {
    result.current.enqueue("ship it");
  });

  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]?.[0]).toBe("ship it");
});

test("a message enqueued mid-flight survives the flush that did not include it", async () => {
  let release: (() => void) | undefined;
  const send = mock(
    (_text: string) =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const { result, rerender } = setup({ send });

  act(() => {
    result.current.enqueue("first");
  });
  rerender({ canFlush: true });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

  // Arrives AFTER the merge snapshot was taken.
  act(() => {
    result.current.enqueue("second");
  });
  await act(async () => {
    release?.();
    await Promise.resolve();
  });

  // A wholesale clear() would have deleted "second" — it was never sent.
  await waitFor(() =>
    expect(result.current.queued.map((m) => m.text)).toEqual(["second"]),
  );
});

test("session_busy keeps the queue, shows the retry notice, and retries", async () => {
  let attempt = 0;
  const send = mock((_text: string) => {
    attempt += 1;
    return attempt === 1 ? Promise.reject(busyError()) : Promise.resolve();
  });
  // The busy notice is TRANSIENT — the successful retry clears it. `waitFor`
  // polls every 50 ms, so the suite-default 5 ms backoff closes the window
  // before it can ever be observed; widen it for this case only.
  const { result, rerender, onGiveUp } = setup({ send, retryDelayMs: 200 });

  act(() => {
    result.current.enqueue("follow-up");
  });
  rerender({ canFlush: true });

  await waitFor(() =>
    expect(result.current.notice).toBe(
      "Still finishing up — your queued message will send shortly.",
    ),
  );
  // The text is still queued, not handed back.
  expect(result.current.queued).toHaveLength(1);
  expect(onGiveUp).not.toHaveBeenCalled();

  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.queued).toHaveLength(0));
  expect(result.current.notice).toBeNull();
});

test("five consecutive busy 409s give the text back instead of retrying forever", async () => {
  const send = mock((_text: string) => Promise.reject(busyError()));
  const { result, rerender, onGiveUp } = setup({ send });

  act(() => {
    result.current.enqueue("a");
    result.current.enqueue("b");
  });
  rerender({ canFlush: true });

  await waitFor(() => expect(onGiveUp).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledTimes(5);
  expect(onGiveUp.mock.calls[0]?.[0]).toBe("a\n\nb");
  expect(result.current.queued).toHaveLength(0);
  expect(result.current.notice).toContain("wasn’t sent");
});

test("a pending retry is cancelled when the slot is taken again", async () => {
  const send = mock((_text: string) => Promise.reject(busyError()));
  const { result, rerender } = setup({ send, retryDelayMs: 40 });

  act(() => {
    result.current.enqueue("later");
  });
  rerender({ canFlush: true });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

  // Another run took the slot before the backoff elapsed.
  rerender({ canFlush: false });
  await new Promise((resolve) => setTimeout(resolve, 80));

  // No second attempt fired into a slot the client knows is busy.
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.current.queued).toHaveLength(1);
});

test("session_not_active retires immediately — it never consumes retries", async () => {
  const send = mock((_text: string) => Promise.reject(deadError()));
  const { result, rerender, onGiveUp, onRetired } = setup({ send });

  act(() => {
    result.current.enqueue("hello");
  });
  rerender({ canFlush: true });

  await waitFor(() => expect(onRetired).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledTimes(1);
  expect(onGiveUp.mock.calls[0]?.[0]).toBe("hello");
  expect(result.current.queued).toHaveLength(0);
});

test("remove drops one message, clear drops all, and blank text never queues", () => {
  const { result } = setup();

  act(() => {
    result.current.enqueue("one");
    result.current.enqueue("two");
    result.current.enqueue("   ");
  });
  expect(result.current.queued).toHaveLength(2);

  const firstId = result.current.queued[0]!.id;
  act(() => {
    result.current.remove(firstId);
  });
  expect(result.current.queued.map((m) => m.text)).toEqual(["two"]);

  act(() => {
    result.current.clear();
  });
  expect(result.current.queued).toHaveLength(0);
});

test("mergeQueued joins with a blank line so items stay separate paragraphs", () => {
  expect(
    mergeQueued([
      { id: "qm_a", text: "first" },
      { id: "qm_b", text: "second" },
    ]),
  ).toBe("first\n\nsecond");
});
