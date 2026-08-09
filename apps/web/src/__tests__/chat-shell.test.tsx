/**
 * ChatShell's discard guard: switching sessions with a non-empty queue must
 * ask first, because the queue is per-thread and the keyed ThreadContainer
 * remounts on switch — which would drop typed text with no trace.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { DiscardQueueDialog } from "../components/chat/DiscardQueueDialog";

ensureDomForThisFile();
afterEach(cleanup);

test("the discard dialog names how many messages are at stake", () => {
  const onConfirm = mock(() => {});
  const view = render(
    <DiscardQueueDialog open count={2} onClose={() => {}} onConfirm={onConfirm} />,
  );
  expect(view.getByText(/Discard 2 queued messages\?/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /Discard/ }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

test("one queued message is singular — copy must not read '1 messages'", () => {
  const view = render(
    <DiscardQueueDialog open count={1} onClose={() => {}} onConfirm={() => {}} />,
  );
  expect(view.getByText(/Discard 1 queued message\?/)).toBeTruthy();
});

test("the dialog closes itself when a flush empties the queue underneath it", async () => {
  const onClose = mock(() => {});
  const view = render(
    <DiscardQueueDialog open count={2} onClose={onClose} onConfirm={() => {}} />,
  );
  // The queue flushed while the dialog was open: there is nothing left to
  // discard, and offering to discard already-sent messages is a lie.
  view.rerender(
    <DiscardQueueDialog open count={0} onClose={onClose} onConfirm={() => {}} />,
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});
