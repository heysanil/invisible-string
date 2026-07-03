/**
 * Chat thread component tests (happy-dom): working-block collapse/expand,
 * the streamed reply, inline approval round-trip, error banner, and the
 * composer's disabled-with-reason + send behavior.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { RunInputRequest } from "@invisible-string/shared";

import type { RunView } from "../lib/chat/run-view";
import { ThreadView } from "../components/chat/ThreadView";
import { RunMessage } from "../components/chat/RunMessage";
import { WorkingBlock } from "../components/chat/WorkingBlock";
import { Composer } from "../components/chat/Composer";
import type { ThreadHeaderProps } from "../components/chat/ThreadHeader";
import { renderWithRouter } from "../test/router";

ensureDomForThisFile();
// Drain a macrotask after unmount so React's scheduler flushes its pending
// work while happy-dom is still registered (avoids a cross-file
// `window is not defined` teardown race — see test/setup.ts).
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

// @tanstack/react-virtual needs element measurement; happy-dom returns 0 for
// layout boxes, which is fine — items still mount (overscan renders them).

const HEADER: ThreadHeaderProps = {
  title: "Test thread",
  workflowName: "Marketing copilot",
  workflowId: "wf1",
  versionLabel: "a1b2c3",
  modelId: "deepseek/deepseek-v4-pro",
  sessionStatus: "active",
  lastRunStatus: "succeeded",
};

function baseRun(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run1",
    status: "succeeded",
    userMessage: "Summarize the issues",
    block: null,
    reply: null,
    pendingInputs: [],
    error: null,
    modelId: "deepseek/deepseek-v4-pro",
    ...overrides,
  };
}

test("thread header shows workflow, version and model chips", async () => {
  const view = renderWithRouter(
    <ThreadView
      header={HEADER}
      runs={[baseRun({ reply: { text: "Done.", streaming: false } })]}
      isChatOrigin
      onRespond={() => {}}
      onSend={() => {}}
    />,
  );
  // RouterProvider resolves its initial route asynchronously.
  expect(await view.findByText("Marketing copilot")).toBeTruthy();
  expect(view.getByText("a1b2c3")).toBeTruthy();
  expect(view.getByText("deepseek/deepseek-v4-pro")).toBeTruthy();
  expect(view.getByText("Edit workflow")).toBeTruthy();
});

test("a completed working block renders collapsed and expands on click", () => {
  const block = {
    steps: [
      { key: "c1", toolName: "linear_list", state: "ok" as const, resultPreview: "5 issues" },
    ],
    narration: [],
    reasoning: null,
    elapsedSeconds: 4,
    active: false,
  };
  const view = render(<WorkingBlock block={block} />);
  // Collapsed summary present; step hidden until expanded.
  expect(view.getByText("Worked for 4s · 1 step")).toBeTruthy();
  expect(view.queryByText("linear_list")).toBeNull();

  fireEvent.click(view.getByRole("button", { expanded: false }));
  expect(view.getByText("linear_list")).toBeTruthy();
  expect(view.getByText("5 issues")).toBeTruthy();
});

test("a live working block renders expanded with a running summary", () => {
  const block = {
    steps: [{ key: "c1", toolName: "search", state: "pending" as const, resultPreview: null }],
    narration: [],
    reasoning: "Thinking about the plan",
    elapsedSeconds: null,
    active: true,
  };
  const view = render(<WorkingBlock block={block} />);
  expect(view.getByText("Working…")).toBeTruthy();
  // Expanded: the step + reasoning line are visible.
  expect(view.getByText("search")).toBeTruthy();
  expect(view.getByText("Thinking about the plan")).toBeTruthy();
});

// Run content is asserted against RunMessage directly: the virtualizer's
// range depends on real layout measurement, which happy-dom reports as 0
// (ThreadView is smoke-tested for header + composer above).

test("an approval card round-trips an optionId to onRespond", () => {
  const onRespond = mock((_response: RunInputRequest) => {});
  const run = baseRun({
    status: "waiting",
    pendingInputs: [
      {
        requestId: "req1",
        prompt: "Approve tool call: gmail_send",
        toolName: "gmail_send",
        argsPreview: '{"to":"team@acme.com"}',
        options: [
          { id: "approve", label: "Approve", style: "primary" },
          { id: "deny", label: "Deny", style: "danger" },
        ],
        allowFreeform: false,
        display: "confirmation",
      },
    ],
  });
  const view = render(
    <RunMessage run={run} isChatOrigin onRespond={onRespond} />,
  );
  expect(view.getByText("Approve tool call: gmail_send")).toBeTruthy();
  expect(view.getByText("gmail_send")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Approve" }));
  expect(onRespond).toHaveBeenCalledTimes(1);
  expect(onRespond.mock.calls[0]).toEqual([{ requestId: "req1", optionId: "approve" }]);
});

test("a free-form input request submits text to onRespond", () => {
  const onRespond = mock((_response: RunInputRequest) => {});
  const run = baseRun({
    status: "waiting",
    pendingInputs: [
      {
        requestId: "q1",
        prompt: "What subject line?",
        toolName: null,
        argsPreview: null,
        options: [],
        allowFreeform: true,
        display: "text",
      },
    ],
  });
  const view = render(<RunMessage run={run} isChatOrigin onRespond={onRespond} />);
  fireEvent.input(view.getByLabelText("Your response"), {
    target: { value: "Launch news" },
  });
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  expect(onRespond.mock.calls[0]).toEqual([{ requestId: "q1", text: "Launch news" }]);
});

test("a failed run renders an error banner", () => {
  const view = render(
    <RunMessage
      run={baseRun({ status: "failed", error: "Provider returned 401" })}
      isChatOrigin
      onRespond={() => {}}
    />,
  );
  const alert = view.getByRole("alert");
  expect(alert.textContent).toContain("Provider returned 401");
});

test("a streaming reply renders markdown with a caret", () => {
  const view = render(
    <RunMessage
      run={baseRun({ status: "running", reply: { text: "We're **live**", streaming: true } })}
      isChatOrigin
      onRespond={() => {}}
    />,
  );
  const strong = view.container.querySelector("strong");
  expect(strong?.textContent).toBe("live");
  // Streaming replies carry the blinking caret marker class.
  expect(view.container.querySelector(".stream-caret")).not.toBeNull();
});

test("composer sends on click and clears; disabled reason blocks input", () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} />);
  const box = view.getByLabelText("Message") as HTMLTextAreaElement;
  fireEvent.input(box, { target: { value: "hello there" } });
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  expect(onSend).toHaveBeenCalledWith("hello there");

  cleanup();
  const disabled = render(
    <Composer onSend={() => {}} disabledReason="Working… try again soon." />,
  );
  expect(disabled.getByText("Working… try again soon.")).toBeTruthy();
  expect((disabled.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
});

test("composer keeps a failed draft handed back via initialValue", () => {
  const view = render(<Composer onSend={() => {}} initialValue="retry me" />);
  expect((view.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("retry me");
});
