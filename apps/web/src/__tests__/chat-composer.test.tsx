/**
 * The Tiptap chat composer, driven as a real ProseMirror view under happy-dom.
 *
 * ProseMirror turns out to mount and edit fine here (unlike CodeMirror, which
 * this suite has to skip), so these are DOM tests rather than tests of an
 * extracted decision function. Input rides `test/editor.ts` — see its header
 * for why paste stands in for typing.
 *
 * What makes these meaningful: every case below fires Enter IMMEDIATELY after
 * the input, inside the 180 ms window where `RichTextEditor`'s debounced
 * `onChange` has not run. A composer that sent its React state instead of
 * flushing the editor would send stale text — or, on a first message, nothing.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Composer } from "../components/chat/Composer";
import { RunMessage } from "../components/chat/RunMessage";
import type { RunView } from "../lib/chat/run-view";
import { pasteInto as paste } from "../test/editor";

ensureDomForThisFile();
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("Enter sends what is in the box right now, not the debounced value", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} />);
  const box = await view.findByLabelText("Message");

  paste(box, "ship the release notes");
  fireEvent.keyDown(box, { key: "Enter" });

  expect(onSend.mock.calls).toEqual([["ship the release notes"]]);
  // …and the box is empty again, ready for the next message.
  expect(box.textContent).toBe("");
});

test("the composer speaks markdown — the message is sent as typed", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} />);
  const box = await view.findByLabelText("Message");

  paste(box, "make it **bold** and `terse`");
  fireEvent.keyDown(box, { key: "Enter" });

  expect(onSend.mock.calls[0]).toEqual(["make it **bold** and `terse`"]);
});

test("Shift+Enter is a newline, not a send", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} />);
  const box = await view.findByLabelText("Message");

  paste(box, "first line");
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(onSend).not.toHaveBeenCalled();
  expect(box.textContent).toContain("first line");

  paste(box, "second line");
  fireEvent.keyDown(box, { key: "Enter" });
  // A hard break survives to the wire as markdown's two-space line ending.
  expect(onSend.mock.calls[0]?.[0]).toBe("first line  \nsecond line");
});

test("Enter mid-IME-composition commits the candidate instead of sending", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} />);
  const box = await view.findByLabelText("Message");

  paste(box, "こんにち");
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  expect(onSend).not.toHaveBeenCalled();
});

test("the send button sends and clears; an empty box cannot be sent", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} />);
  const box = view.getByLabelText("Message");
  const send = view.getByRole("button", { name: "Send message" });

  // Nothing typed yet — the affordance is dimmed and inert.
  expect((send as HTMLButtonElement).disabled).toBe(true);

  paste(box, "hello there");
  // Emptiness is the ONE thing the button reads from the debounced value, so
  // it enables a beat after the last keystroke (a mouse takes longer than
  // that to arrive). What it sends is still read live, not from that value.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  expect((send as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(send);
  expect(onSend.mock.calls).toEqual([["hello there"]]);
  expect(box.textContent).toBe("");
  expect((send as HTMLButtonElement).disabled).toBe(true);
});

test("a disabled composer states the reason and refuses input", () => {
  const onSend = mock((_message: string) => {});
  const view = render(
    <Composer onSend={onSend} disabledReason="Working… try again soon." />,
  );
  expect(view.getByText("Working… try again soon.")).toBeTruthy();

  const box = view.getByLabelText("Message");
  // A contenteditable has no `disabled`; read-only is how ProseMirror says it.
  expect(box.getAttribute("contenteditable")).toBe("false");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
});

test("a failed send hands the draft back through initialValue", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} />);
  const box = await view.findByLabelText("Message");

  paste(box, "retry me");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(box.textContent).toBe("");

  // What the thread does when the dispatch comes back 5xx: re-seed the box.
  view.rerender(<Composer onSend={onSend} initialValue="retry me" />);
  expect(view.getByLabelText("Message").textContent).toBe("retry me");

  fireEvent.keyDown(view.getByLabelText("Message"), { key: "Enter" });
  expect(onSend.mock.calls).toEqual([["retry me"], ["retry me"]]);
});

// ── Stop on the send button + queueing ──────────────────────────────────────

test("no Stop control when nothing is stoppable", async () => {
  const view = render(<Composer onSend={() => {}} />);
  await view.findByLabelText("Message");
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(view.getByRole("button", { name: "Send message" })).toBeTruthy();
});

test("an empty box during a run shows Stop instead of send", async () => {
  const onStop = mock(() => {});
  const view = render(<Composer onSend={() => {}} onStop={onStop} queueing />);
  await view.findByLabelText("Message");

  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  expect(onStop).toHaveBeenCalledTimes(1);
  // The submit button is not competing for the same spot.
  expect(view.queryByRole("button", { name: /message$/ })).toBeNull();
});

test("typing during a run shows BOTH Stop and Queue — neither action is mouse-inaccessible", async () => {
  const onSend = mock((_message: string) => {});
  const onStop = mock(() => {});
  const view = render(<Composer onSend={onSend} onStop={onStop} queueing />);
  const box = await view.findByLabelText("Message");

  paste(box, "and link the images");

  const queue = await view.findByRole("button", { name: "Queue message" });
  fireEvent.click(queue);
  expect(onSend.mock.calls).toEqual([["and link the images"]]);
  expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("Enter queues rather than sends while a run holds the slot", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} onStop={() => {}} queueing />);
  const box = await view.findByLabelText("Message");

  paste(box, "keep it under 200 words");
  fireEvent.keyDown(box, { key: "Enter" });

  // Same callback either way — the parent routes on `queueing`. What matters
  // is that the flush still happened: the debounced value is 180 ms behind.
  expect(onSend.mock.calls).toEqual([["keep it under 200 words"]]);
  expect(box.textContent).toBe("");
});

test("Escape stops the run, and does nothing when there is nothing to stop", async () => {
  const onStop = mock(() => {});
  const view = render(<Composer onSend={() => {}} onStop={onStop} queueing />);
  const box = await view.findByLabelText("Message");
  fireEvent.keyDown(box, { key: "Escape" });
  expect(onStop).toHaveBeenCalledTimes(1);

  cleanup();
  const plain = render(<Composer onSend={() => {}} />);
  const plainBox = await plain.findByLabelText("Message");
  // No throw, no stop — Escape is inert without a stoppable run.
  fireEvent.keyDown(plainBox, { key: "Escape" });
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("a background flush does not block queuing by mouse", async () => {
  const onSend = mock((_message: string) => {});
  // `sending` is true because the QUEUE is flushing, not because this box sent.
  const view = render(
    <Composer onSend={onSend} onStop={() => {}} queueing sending />,
  );
  const box = await view.findByLabelText("Message");

  paste(box, "one more thing");
  const queue = await view.findByRole("button", { name: "Queue message" });
  expect((queue as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(queue);
  expect(onSend.mock.calls).toEqual([["one more thing"]]);
});

test("the placeholder never changes when queueing flips — the draft must survive", async () => {
  const view = render(<Composer onSend={() => {}} placeholder="Message Release Notes…" />);
  const box = await view.findByLabelText("Message");
  paste(box, "half a thought");

  // A run starts underneath the user mid-sentence.
  view.rerender(
    <Composer
      onSend={() => {}}
      placeholder="Message Release Notes…"
      onStop={() => {}}
      queueing
    />,
  );

  // Same editor instance, same text. Changing `placeholder` (or `ariaLabel`)
  // is in useEditor's dep array and would have rebuilt the editor, silently
  // destroying this draft — the exact scenario the queue exists for.
  const after = await view.findByLabelText("Message");
  expect(after.textContent).toContain("half a thought");
});

test("a retired session is the only thing that still freezes the box", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(
    <Composer onSend={onSend} disabledReason="This session has been retired — start a new chat." />,
  );
  const box = await view.findByLabelText("Message");
  paste(box, "anything");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  expect(view.getByText(/has been retired/)).toBeTruthy();
});

test("a restored draft appends — it never overwrites what the user is typing", async () => {
  const onRestoreConsumed = mock(() => {});
  const view = render(
    <Composer onSend={() => {}} onRestoreConsumed={onRestoreConsumed} />,
  );
  const box = await view.findByLabelText("Message");
  paste(box, "a new thought");

  // A queued flush gave up ~10 s after the user started typing again.
  view.rerender(
    <Composer
      onSend={() => {}}
      restoreDraft="the message that failed to send"
      onRestoreConsumed={onRestoreConsumed}
    />,
  );

  await waitFor(() => {
    expect(box.textContent).toContain("a new thought");
    expect(box.textContent).toContain("the message that failed to send");
  });
  // Consumed exactly once, so a re-render cannot append it twice.
  expect(onRestoreConsumed).toHaveBeenCalledTimes(1);
});

test("a restored draft seeds an empty box without a leading blank line", async () => {
  const view = render(<Composer onSend={() => {}} restoreDraft="just this" onRestoreConsumed={() => {}} />);
  const box = await view.findByLabelText("Message");
  await waitFor(() => expect(box.textContent).toBe("just this"));
});

test("the hint is announced without disabling anything", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(
    <Composer onSend={onSend} hint="Still finishing up — your queued message will send shortly." />,
  );
  const box = await view.findByLabelText("Message");
  const hint = view.getByText(/Still finishing up/);
  expect(hint.getAttribute("aria-live")).toBe("polite");

  paste(box, "still typeable");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend.mock.calls).toEqual([["still typeable"]]);
});

// ── The other half of the round trip: the bubble the message lands in ───────

function chatRun(userMessage: string): RunView {
  return {
    runId: "run1",
    status: "succeeded",
    userMessage,
    segments: [],
    pendingInputs: [],
    error: null,
    modelId: "deepseek/deepseek-v4-pro",
    canceled: false,
    contextCleared: false,
  };
}

test("the user's own bubble renders markdown rather than echoing syntax", async () => {
  const view = render(
    <RunMessage
      run={chatRun("make it **bold** and `terse`")}
      isChatOrigin
      onRespond={() => {}}
    />,
  );
  // Assert the OUTCOME, not the tag: Streamdown renders emphasis as a styled
  // span rather than <strong>, and pinning the markup to one renderer is what
  // made this test break when the renderer was swapped underneath it.
  // Streamdown also suspends while Shiki loads, so nothing is in the DOM yet.
  await waitFor(() =>
    expect(view.container.textContent).toContain("make it bold and terse"),
  );
  // No literal asterisks or backticks left over for the author to read.
  expect(view.container.textContent).not.toContain("**");
  expect(view.container.textContent).not.toContain("`");
  // The ink bubble flips the renderer's tokens rather than forking its styles.
  expect(view.container.querySelector(".md-on-ink")).not.toBeNull();
});

test("a Shift+Enter line break survives into the bubble", () => {
  const view = render(
    <RunMessage run={chatRun("first line  \nsecond line")} isChatOrigin onRespond={() => {}} />,
  );
  expect(view.container.querySelector("br")).not.toBeNull();
  expect(view.container.textContent).toContain("first line");
  expect(view.container.textContent).toContain("second line");
});

test("a trigger-origin run still shows its message as a provenance note", () => {
  const view = render(
    <RunMessage run={chatRun("Webhook: deploy failed")} isChatOrigin={false} onRespond={() => {}} />,
  );
  expect(view.getByText("Webhook: deploy failed")).toBeTruthy();
});
