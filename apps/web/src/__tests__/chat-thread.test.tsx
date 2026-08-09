/**
 * Chat thread component tests (happy-dom): working-block collapse/expand,
 * the streamed reply, the HITL card's three `kind` routes, the Stop control
 * and its NON-failure cancelled state, the session-actions menu, the error
 * banner, and the composer's disabled-with-reason + send behavior.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

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
  agentName: "Executive assistant",
  agentId: "ag1",
  versionLabel: "a1b2c3",
  modelId: "deepseek/deepseek-v4-pro",
  workflowName: null,
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
    canceled: false,
    contextCleared: false,
    ...overrides,
  };
}

test("thread header shows agent, version and model chips", async () => {
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
  expect(await view.findByText("Executive assistant")).toBeTruthy();
  expect(view.getByText("a1b2c3")).toBeTruthy();
  expect(view.getByText("deepseek/deepseek-v4-pro")).toBeTruthy();
  expect(view.getByText("Edit agent")).toBeTruthy();
  // Chat-origin sessions carry no workflow provenance chip.
  expect(view.queryByTitle("Started by workflow")).toBeNull();
});

test("a trigger-origin header adds the workflow provenance chip", async () => {
  const view = renderWithRouter(
    <ThreadView
      header={{ ...HEADER, workflowName: "Nightly metrics digest" }}
      runs={[baseRun()]}
      isChatOrigin={false}
      onRespond={() => {}}
      onSend={() => {}}
    />,
  );
  expect(await view.findByText("Nightly metrics digest")).toBeTruthy();
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
  // Collapsed summary present; the body stays mounted (it animates the fold via
  // grid-rows) but is hidden from view + assistive tech until expanded.
  expect(view.getByText("Worked for 4s · 1 step")).toBeTruthy();
  expect(
    view.getByText("linear_list").closest("[aria-hidden='true']"),
  ).not.toBeNull();

  fireEvent.click(view.getByRole("button", { expanded: false }));
  // Expanded: aria-hidden clears and the step detail is revealed.
  expect(view.getByRole("button", { expanded: true })).toBeTruthy();
  expect(
    view.getByText("linear_list").closest("[aria-hidden='true']"),
  ).toBeNull();
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
  const onRespond = mock((_runId: string, _response: RunInputRequest) => {});
  const run = baseRun({
    status: "waiting",
    pendingInputs: [
      {
        requestId: "req1",
        kind: "tool-approval",
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
  // The card names its kind to assistive tech and shows the gated tool.
  expect(view.getByRole("group", { name: "Approval requested" })).toBeTruthy();
  expect(view.getByText("Approve tool call: gmail_send")).toBeTruthy();
  expect(view.getByText("gmail_send")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Approve" }));
  expect(onRespond).toHaveBeenCalledTimes(1);
  expect(onRespond.mock.calls[0]).toEqual(["run1", { requestId: "req1", optionId: "approve" }]);
});

test("a question routes on kind, not on its gating tool name", () => {
  const run = baseRun({
    status: "waiting",
    pendingInputs: [
      {
        requestId: "q9",
        kind: "question",
        prompt: "Which mailbox should I use?",
        // run-view suppresses the tool for a question; assert the card agrees.
        toolName: null,
        argsPreview: null,
        options: [{ id: "work", label: "Work" }],
        allowFreeform: true,
        display: "select",
      },
    ],
  });
  const view = render(<RunMessage run={run} isChatOrigin onRespond={() => {}} />);
  expect(view.getByRole("group", { name: "Question from the agent" })).toBeTruthy();
  expect(view.getByText("Which mailbox should I use?")).toBeTruthy();
  // No approval framing on a plain question.
  expect(view.queryByText("ask_question")).toBeNull();
});

test("a session-limit prompt renders as its own decision, not a tool approval", () => {
  const onRespond = mock((_runId: string, _response: RunInputRequest) => {});
  const run = baseRun({
    status: "waiting",
    pendingInputs: [
      {
        requestId: "s1:limit:input:40120433",
        kind: "session-limit",
        prompt:
          "This session has hit the input-token limit (40M) per session. This is a guardrail against defective long-running sessions.",
        toolName: null,
        argsPreview: null,
        options: [
          { id: "continue", label: "Approve", description: "Grant a fresh token budget", style: "primary" },
          { id: "stop", label: "Stop", description: "Stop now", style: "danger" },
        ],
        allowFreeform: false,
        display: "confirmation",
      },
    ],
  });
  const view = render(<RunMessage run={run} isChatOrigin onRespond={onRespond} />);
  expect(view.getByRole("group", { name: "Session limit reached" })).toBeTruthy();
  // eve's synthetic budget "tool" must never surface as something approved.
  expect(view.queryByText("session_limit_continuation")).toBeNull();
  // eve's own per-option consequences are shown on this card only.
  expect(view.getByText("Grant a fresh token budget")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /Approve/ }));
  expect(onRespond.mock.calls[0]).toEqual([
    "run1",
    { requestId: "s1:limit:input:40120433", optionId: "continue" },
  ]);
});

test("a free-form input request submits text to onRespond", () => {
  const onRespond = mock((_runId: string, _response: RunInputRequest) => {});
  const run = baseRun({
    status: "waiting",
    pendingInputs: [
      {
        requestId: "q1",
        kind: "question",
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
  expect(onRespond.mock.calls[0]).toEqual(["run1", { requestId: "q1", text: "Launch news" }]);
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
  // Streamdown renders `**x**` as a marked span, not a bare <strong>.
  const strong = view.container.querySelector('[data-streamdown="strong"]');
  expect(strong?.textContent).toBe("live");
  // Streamdown sets the caret glyph as an INLINE custom property on its
  // wrapper; there is no data attribute to select on. Note the
  // `content-[var(--streamdown-caret)]` utility sits in the wrapper's class
  // list in both states, so a substring check on the token name would be
  // vacuously true — match the inline style, which is what the blink CSS in
  // index.css keys off too.
  expect(
    view.container.querySelector('[style*="--streamdown-caret"]'),
  ).not.toBeNull();
});

// ── Stop (eve 0.31 turn cancellation) ───────────────────────────────────────

test("a stopped run reads as a user decision, never as a failure", () => {
  const view = render(
    <RunMessage
      run={baseRun({
        status: "canceled",
        canceled: true,
        reply: { text: "I pulled 142 open issues", streaming: false },
      })}
      isChatOrigin
      onRespond={() => {}}
      onCancel={() => {}}
    />,
  );
  // No error banner: eve emits NO failure event for a cancelled turn.
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByText(/You stopped this run/)).toBeTruthy();
  // Whatever streamed before the stop stays readable.
  expect(view.getByText(/142 open issues/)).toBeTruthy();
  // Nothing left to stop.
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
});

test("the Stop button hides the instant turn.cancelled lands, before the status frame", () => {
  // `canceled` is derived from the event stream, so it flips a beat ahead of
  // the run_status frame — the row must settle immediately, not linger.
  const view = render(
    <RunMessage
      run={baseRun({ status: "running", canceled: true })}
      isChatOrigin
      onRespond={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(view.getByText(/You stopped this run/)).toBeTruthy();
});

test("Stop shows a busy state while the request is in flight", () => {
  const view = render(
    <RunMessage
      run={baseRun({ status: "running" })}
      isChatOrigin
      onRespond={() => {}}
      onCancel={() => {}}
      canceling
    />,
  );
  const button = view.getByRole("button", { name: /Stopping/ });
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect((button as HTMLButtonElement).disabled).toBe(true);
});

// ── session-actions menu (context controls) ─────────────────────────────────

test("the session-actions menu offers clear/compact/reset and reports the action", async () => {
  const onContextAction = mock((_action: string) => {});
  const view = renderWithRouter(
    <ThreadView
      header={{ ...HEADER, onContextAction }}
      runs={[baseRun()]}
      isChatOrigin
      onRespond={() => {}}
      onSend={() => {}}
    />,
  );
  fireEvent.click(await view.findByRole("button", { name: "Session actions" }));
  const menu = view.getByRole("dialog", { name: "Session actions" });
  expect(within(menu).getByText("Clear context")).toBeTruthy();
  expect(within(menu).getByText("Compact context")).toBeTruthy();
  expect(within(menu).getByText("Reset session")).toBeTruthy();

  fireEvent.click(within(menu).getByText("Clear context"));
  expect(onContextAction.mock.calls[0]).toEqual(["clear"]);
});

test("the context controls are blocked with a reason while a run is in flight", async () => {
  const view = renderWithRouter(
    <ThreadView
      header={{
        ...HEADER,
        onContextAction: () => {},
        contextActionsBlockedReason: "Wait for the current run to finish, or stop it first.",
      }}
      runs={[baseRun({ status: "running" })]}
      isChatOrigin
      onRespond={() => {}}
      onSend={() => {}}
    />,
  );
  fireEvent.click(await view.findByRole("button", { name: "Session actions" }));
  const menu = view.getByRole("dialog", { name: "Session actions" });
  expect(within(menu).getByText(/Wait for the current run to finish/)).toBeTruthy();
  const clear = within(menu).getByText("Clear context").closest("button");
  expect((clear as HTMLButtonElement).disabled).toBe(true);
});

test("a landed clear renders the neutral context marker", async () => {
  const view = renderWithRouter(
    <ThreadView
      header={HEADER}
      runs={[baseRun()]}
      isChatOrigin
      onRespond={() => {}}
      onSend={() => {}}
      contextMarker="cleared"
    />,
  );
  expect(await view.findByText("Context cleared")).toBeTruthy();
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
