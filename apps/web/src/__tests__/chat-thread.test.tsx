/**
 * Chat thread component tests (happy-dom): working-block collapse/expand,
 * the streamed reply, the HITL card's three `kind` routes, the Stop control
 * and its NON-failure cancelled state, the session-actions menu, the error
 * banner, and the composer's disabled-with-reason + send behavior.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { indexToolDirectory, type RunInputRequest } from "@invisible-string/shared";

import type { RunView, ToolItem, WorkSegment } from "../lib/chat/run-view";
import { ThreadView } from "../components/chat/ThreadView";
import { RunMessage } from "../components/chat/RunMessage";
import { WorkingBlock } from "../components/chat/WorkingBlock";
import { Composer } from "../components/chat/Composer";
import type { ThreadHeaderProps } from "../components/chat/ThreadHeader";
import { renderWithRouter } from "../test/router";
import { pasteInto, pressEnter } from "../test/editor";

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
  modelLabel: "Balanced",
  modelId: "deepseek/deepseek-v4-pro",
  contextUsage: { usedTokens: 262_144, windowTokens: 1_048_576 },
  workflowName: null,
  sessionStatus: "active",
  lastRunStatus: "succeeded",
};

function baseRun(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run1",
    status: "succeeded",
    userMessage: "Summarize the issues",
    segments: [],
    pendingInputs: [],
    authorizations: [],
    error: null,
    modelId: "deepseek/deepseek-v4-pro",
    canceled: false,
    contextCleared: false,
    contextCompacted: false,
    inputTokens: null,
    ...overrides,
  };
}

test("thread header shows the agent, the context budget and a friendly model label", async () => {
  const view = renderWithRouter(
    <ThreadView
      header={HEADER}
      runs={[
        baseRun({
          segments: [
            { kind: "speech", key: "say:t0:0", text: "Done.", streaming: false },
          ],
        }),
      ]}
      isChatOrigin
      onRespond={() => {}}
      onSend={() => {}}
    />,
  );
  // RouterProvider resolves its initial route asynchronously.
  expect(await view.findByText("Executive assistant")).toBeTruthy();
  // Build identity is GONE (spec D6): no pinned version hash, no raw model id.
  expect(view.queryByText("a1b2c3")).toBeNull();
  expect(view.queryByText("deepseek/deepseek-v4-pro")).toBeNull();
  expect(view.getByText("Balanced")).toBeTruthy();
  const meter = view.getByRole("meter", { name: "Context used" });
  expect(meter.getAttribute("aria-valuenow")).toBe("25");
  expect(meter.textContent).toContain("25%");
  expect(view.getByText("Edit agent")).toBeTruthy();
  // Chat-origin sessions carry no workflow provenance chip.
  expect(view.queryByTitle("Started by workflow")).toBeNull();
});

test("the context meter is ABSENT when either half is unknown", async () => {
  // Never zero and never a guess: no usage measured yet, or no published
  // context window for the resolved model, means no meter at all.
  const view = renderWithRouter(
    <ThreadView
      header={{ ...HEADER, contextUsage: null, modelLabel: null }}
      runs={[baseRun()]}
      isChatOrigin
      onRespond={() => {}}
      onSend={() => {}}
    />,
  );
  await view.findByText("Executive assistant");
  expect(view.queryByRole("meter")).toBeNull();
  // And with no friendly label, no chip — rather than falling back to a slug.
  expect(view.queryByText("deepseek/deepseek-v4-pro")).toBeNull();
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

function workSegment(over: Partial<WorkSegment> = {}): WorkSegment {
  return {
    kind: "work",
    key: "work:t0:0",
    items: [
      { kind: "thought", key: "t0:0", text: "Weighing the options", seconds: 4, streaming: false },
      {
        kind: "tool",
        key: "c1",
        toolName: "list_runs",
        state: "ok",
        resultSummary: "14 runs",
        rawResult: null,
      },
    ],
    elapsedSeconds: 24,
    startedAt: "2026-01-01T00:00:00.000Z",
    active: false,
    waiting: false,
    sealed: true,
    ...over,
  };
}

test("a settled work segment folds to a summary counting thoughts as steps", () => {
  const view = render(<WorkingBlock segment={workSegment()} />);
  const toggle = view.getByRole("button", { name: /Worked/ });
  // 1 thought + 1 tool = 2 steps.
  expect(toggle.textContent).toContain("Worked for 24s · 2 steps");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

test("expanding a settled segment reveals thoughts and tools in rail order", () => {
  const view = render(<WorkingBlock segment={workSegment()} />);
  fireEvent.click(view.getByRole("button", { name: /Worked/ }));
  expect(view.getByText("Weighing the options")).toBeTruthy();
  expect(view.getByText("Thought for 4s")).toBeTruthy();
  // A builtin has no connection prefix; it still reads as English, never as
  // the wire name (spec D5).
  expect(view.getByText("List runs")).toBeTruthy();
  expect(view.queryByText("list_runs")).toBeNull();
  const items = view.container.querySelectorAll("li");
  expect(items[0]!.textContent).toContain("Weighing the options");
  expect(items[1]!.textContent).toContain("List runs");
});

// ── tool calls read as English (2026-08-11 spec D5) ─────────────────────────

const TOOL_DIRECTORY = indexToolDirectory({
  agentVersionId: "dddddddd-0001-4000-8000-000000000001",
  connections: [
    {
      slug: "linear",
      connectionId: "cn_testlinear000001",
      connectionName: "Linear",
      tools: [
        {
          name: "create_issue",
          description: "Create an issue in a team.",
          params: ["teamId", "title"],
        },
      ],
    },
  ],
});

function toolSegment(item: Partial<ToolItem> = {}): WorkSegment {
  return workSegment({
    items: [
      {
        kind: "tool",
        key: "c1",
        toolName: "linear__create_issue",
        state: "ok",
        resultSummary: "Created ENG-42",
        rawResult: '{\n  "id": "ENG-42"\n}',
        ...item,
      },
    ],
  });
}

test("a qualified tool call renders connection, humanized name and description", () => {
  const view = render(
    <WorkingBlock segment={toolSegment()} toolDirectory={TOOL_DIRECTORY} />,
  );
  fireEvent.click(view.getByRole("button", { name: /Worked/ }));
  expect(view.getByText("Linear ·")).toBeTruthy();
  expect(view.getByText("Create issue")).toBeTruthy();
  expect(view.getByText("Create an issue in a team.")).toBeTruthy();
  expect(view.getByText("Created ENG-42")).toBeTruthy();
  // The wire name never reaches the screen.
  expect(view.queryByText("linear__create_issue")).toBeNull();
});

test("an unknown slug still names its source instead of going blank", () => {
  // A connection detached since the run, or a directory that never loaded:
  // humanize the slug rather than dropping the only provenance the step has.
  const view = render(
    <WorkingBlock
      segment={toolSegment({ toolName: "github__create_pull_request" })}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: /Worked/ }));
  expect(view.getByText("Github ·")).toBeTruthy();
  expect(view.getByText("Create pull request")).toBeTruthy();
});

test("raw tool output is reachable on demand and never shown by default", () => {
  const view = render(
    <WorkingBlock segment={toolSegment()} toolDirectory={TOOL_DIRECTORY} />,
  );
  fireEvent.click(view.getByRole("button", { name: /Worked/ }));
  expect(view.queryByText(/"id": "ENG-42"/)).toBeNull();
  const toggle = view.getByRole("button", {
    name: "Show raw output from Create issue",
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(view.getByText(/"id": "ENG-42"/)).toBeTruthy();
});

test("a step with nothing to disclose offers no raw toggle", () => {
  const view = render(
    <WorkingBlock
      segment={toolSegment({ rawResult: null, resultSummary: null })}
      toolDirectory={TOOL_DIRECTORY}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: /Worked/ }));
  expect(view.queryByRole("button", { name: /raw output/i })).toBeNull();
});

test("an active segment defaults open and announces Working", () => {
  const view = render(<WorkingBlock segment={workSegment({ active: true, sealed: false })} />);
  const toggle = view.getByRole("button", { name: /Working/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

test("a segment blocked on the user reads Waiting on you, with no counter", () => {
  const view = render(
    <WorkingBlock segment={workSegment({ active: false, waiting: true, sealed: false })} />,
  );
  expect(view.getByRole("button", { name: /Waiting on you/ })).toBeTruthy();
  expect(view.queryByText(/Worked for/)).toBeNull();
});

test("a thought with no measured duration falls back to a bare label", () => {
  const view = render(<WorkingBlock segment={workSegment({
    items: [{ kind: "thought", key: "t0:0", text: "Brief", seconds: null, streaming: false }],
  })} />);
  fireEvent.click(view.getByRole("button", { name: /Worked/ }));
  expect(view.getByText("Thought")).toBeTruthy();
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
  // eve's own "Stop" option is filtered out: it ends the turn through the same
  // path as the composer's Stop, which is permanently mounted, so rendering
  // both would put two controls for one decision next to each other.
  expect(view.queryByRole("button", { name: /Stop/ })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: /Approve/ }));
  expect(onRespond.mock.calls[0]).toEqual([
    "run1",
    { requestId: "s1:limit:input:40120433", optionId: "continue" },
  ]);
});

test("a session-limit prompt whose options are ALL danger still renders them", () => {
  // Degrade to showing everything rather than to a card with nothing to click:
  // the filter exists to remove a redundant control, never to strand the user
  // if a future eve build marks its options differently.
  const run = baseRun({
    status: "waiting",
    pendingInputs: [
      {
        requestId: "s1:limit:input:2",
        kind: "session-limit",
        prompt: "This session has hit the input-token limit.",
        toolName: null,
        argsPreview: null,
        options: [
          { id: "stop", label: "Stop", description: "Stop now", style: "danger" },
          { id: "abort", label: "Abort", description: "End it", style: "danger" },
        ],
        allowFreeform: false,
        display: "confirmation",
      },
    ],
  });
  const view = render(<RunMessage run={run} isChatOrigin onRespond={() => {}} />);
  expect(view.getByRole("button", { name: /Stop/ })).toBeTruthy();
  expect(view.getByRole("button", { name: /Abort/ })).toBeTruthy();
});

test("a tool approval keeps its danger option — Deny is a refusal, not a stop", () => {
  // The composer's Stop cancels the turn; it cannot express "run everything
  // else but NOT this side effect". So the filter must stay scoped to
  // session-limit prompts.
  const onRespond = mock((_runId: string, _response: RunInputRequest) => {});
  const run = baseRun({
    status: "waiting",
    pendingInputs: [
      {
        requestId: "s1:tool:input:9",
        kind: "tool-approval",
        prompt: "Delete the staging bucket?",
        toolName: "s3_delete_bucket",
        argsPreview: '{"bucket":"staging"}',
        options: [
          { id: "allow", label: "Allow", style: "primary" },
          { id: "deny", label: "Deny", style: "danger" },
        ],
        allowFreeform: false,
        display: "confirmation",
      },
    ],
  });
  const view = render(<RunMessage run={run} isChatOrigin onRespond={onRespond} />);
  fireEvent.click(view.getByRole("button", { name: /Deny/ }));
  expect(onRespond.mock.calls[0]).toEqual([
    "run1",
    { requestId: "s1:tool:input:9", optionId: "deny" },
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
      run={baseRun({
        status: "running",
        segments: [
          { kind: "speech", key: "say:t0:0", text: "We're **live**", streaming: true },
        ],
      })}
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
        segments: [
          {
            kind: "speech",
            key: "say:t0:0",
            text: "I pulled 142 open issues",
            streaming: false,
          },
        ],
      })}
      isChatOrigin
      onRespond={() => {}}
    />,
  );
  // No error banner: eve emits NO failure event for a cancelled turn.
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByText(/You stopped this run/)).toBeTruthy();
  // Whatever streamed before the stop stays readable.
  expect(view.getByText(/142 open issues/)).toBeTruthy();
});

test("the transcript never offers Stop — it lives on the composer now", () => {
  // Virtualization can scroll a transcript button out of the DOM entirely
  // while a run streams; the composer is always mounted.
  const view = render(
    <RunMessage run={baseRun({ status: "running" })} isChatOrigin onRespond={() => {}} />,
  );
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
});

test("ThreadView puts Stop on the composer while a run is stoppable", async () => {
  const onStop = mock(() => {});
  const view = renderWithRouter(
    <ThreadView
      header={HEADER}
      runs={[baseRun({ status: "running" })]}
      isChatOrigin
      onRespond={() => {}}
      onStop={onStop}
      onSend={() => {}}
    />,
  );
  fireEvent.click(await view.findByRole("button", { name: "Stop" }));
  expect(onStop).toHaveBeenCalledTimes(1);
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

// ── compaction persists the way clearing does (2026-08-11 spec D4) ─────────

test("a run that observed a completed compaction draws the divider inline", () => {
  const view = render(
    <RunMessage
      run={baseRun({ contextCompacted: true })}
      isChatOrigin
      onRespond={() => {}}
    />,
  );
  expect(view.getByText("Context compacted")).toBeTruthy();
  expect(view.queryByText("Context cleared")).toBeNull();
});

test("a run with no compaction event claims no compaction", () => {
  const view = render(
    <RunMessage run={baseRun()} isChatOrigin onRespond={() => {}} />,
  );
  expect(view.queryByText("Context compacted")).toBeNull();
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

// The composer's own behavior (Enter/Shift+Enter, flush-on-send, clearing)
// lives in __tests__/chat-composer.test.tsx; these two keep the thread's
// contract with it — the label it is found by, and the disabled reason.

test("composer sends on Enter; a disabled reason blocks input", () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} />);
  const box = view.getByLabelText("Message");
  pasteInto(box, "hello there");
  pressEnter(box);
  expect(onSend).toHaveBeenCalledWith("hello there");

  cleanup();
  const disabled = render(
    <Composer onSend={() => {}} disabledReason="Working… try again soon." />,
  );
  expect(disabled.getByText("Working… try again soon.")).toBeTruthy();
  // A contenteditable has no `disabled` — read-only is how ProseMirror says it.
  expect(disabled.getByLabelText("Message").getAttribute("contenteditable")).toBe(
    "false",
  );
});

test("composer keeps a failed draft handed back via initialValue", () => {
  const view = render(<Composer onSend={() => {}} initialValue="retry me" />);
  expect(view.getByLabelText("Message").textContent).toBe("retry me");
});
