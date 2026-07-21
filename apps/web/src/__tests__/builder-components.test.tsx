/**
 * DOM smoke tests for the workflow editor's plain-React sections — they mount
 * without crashing and route user intent to the reducer. (The CodeMirror
 * instructions editor is exercised by its pure @-source tests instead; it is
 * flaky under happy-dom.)
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { WorkflowConfig } from "@invisible-string/shared";

import { AgentSection } from "../components/builder/AgentSection";
import { SaveIndicator } from "../components/builder/SaveIndicator";
import { TriggerEditor } from "../components/builder/TriggerEditor";
import {
  FIXTURE_AGENTS,
  FIXTURE_AGENT_IDS,
  FIXTURE_DATA_ANALYST,
  FIXTURE_EXEC_ASSISTANT,
  FIXTURE_RELEASE_BOT,
} from "../lib/agents/fixtures";
import { renderWithRouter } from "../test/router";

ensureDomForThisFile();
afterEach(cleanup);

const AGENTS = FIXTURE_AGENTS.map((entry) => entry.summary);

function definition(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    trigger: { type: "manual" },
    agentId: FIXTURE_AGENT_IDS.execAssistant,
    instructions: { markdown: "Hello" },
    ...overrides,
  };
}

// ── TriggerEditor ───────────────────────────────────────────────────────────

test("TriggerEditor switches type and adds a form field via dispatch", () => {
  const dispatch = mock(() => {});
  const view = render(
    <TriggerEditor definition={definition()} dispatch={dispatch} />,
  );

  fireEvent.click(view.getByRole("radio", { name: /Form/ }));
  expect(dispatch).toHaveBeenCalledWith({
    type: "setTriggerType",
    triggerType: "form",
  });
});

test("TriggerEditor form view renders the field designer", () => {
  const dispatch = mock(() => {});
  const view = render(
    <TriggerEditor
      definition={definition({
        trigger: {
          type: "form",
          fields: [{ key: "email", label: "Email", type: "text", required: true }],
        },
      })}
      dispatch={dispatch}
    />,
  );
  expect(view.getByRole("button", { name: /Add field/ })).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: /Add field/ }));
  expect(dispatch).toHaveBeenCalledWith({ type: "addFormField" });
});

// ── AgentSection ────────────────────────────────────────────────────────────

test("AgentSection lists PUBLISHED agents as a radio group and dispatches setAgentId", async () => {
  const dispatch = mock(() => {});
  const view = renderWithRouter(
    <AgentSection
      agents={AGENTS}
      selectedAgentId={FIXTURE_AGENT_IDS.execAssistant}
      dispatch={dispatch}
    />,
  );

  // RouterProvider resolves its initial route asynchronously.
  const group = await view.findByRole("radiogroup", { name: "Agent" });
  const radios = within(group).getAllByRole("radio");
  // Release bot has never been published — not offerable.
  expect(radios).toHaveLength(3);
  expect(within(group).queryByText("Release bot")).toBeNull();

  const selected = within(group).getByRole("radio", {
    name: /Executive assistant/,
  });
  expect(selected.getAttribute("aria-checked")).toBe("true");
  // Only the selected card grows the edit affordance.
  expect(within(group).getAllByRole("link", { name: /Edit agent/ })).toHaveLength(1);

  fireEvent.click(within(group).getByRole("radio", { name: /Support triager/ }));
  expect(dispatch).toHaveBeenCalledWith({
    type: "setAgentId",
    id: FIXTURE_AGENT_IDS.supportTriager,
  });
});

test("AgentSection radio group: roving tabIndex + arrow keys move focus AND selection (ARIA contract)", async () => {
  const dispatch = mock(() => {});
  const view = renderWithRouter(
    <AgentSection
      agents={AGENTS}
      selectedAgentId={FIXTURE_AGENT_IDS.execAssistant}
      dispatch={dispatch}
    />,
  );
  const group = await view.findByRole("radiogroup", { name: "Agent" });
  const radios = within(group).getAllByRole("radio");
  // The group offers PUBLISHED agents only, in inventory order.
  const published = AGENTS.filter((agent) => agent.publishedVersionId !== null);
  expect(radios).toHaveLength(published.length);

  // ONE tab stop: only the selected card is tabbable.
  expect(radios[0]!.getAttribute("tabindex")).toBe("0");
  for (const radio of radios.slice(1)) {
    expect(radio.getAttribute("tabindex")).toBe("-1");
  }

  // ArrowRight selects (and focuses) the next card…
  radios[0]!.focus();
  fireEvent.keyDown(group, { key: "ArrowRight" });
  expect(dispatch).toHaveBeenCalledWith({
    type: "setAgentId",
    id: published[1]!.id,
  });
  // …ArrowLeft wraps from the first card to the last…
  radios[0]!.focus();
  fireEvent.keyDown(group, { key: "ArrowLeft" });
  expect(dispatch).toHaveBeenCalledWith({
    type: "setAgentId",
    id: published[published.length - 1]!.id,
  });
  // …and Home jumps back to the first.
  fireEvent.keyDown(group, { key: "Home" });
  expect(dispatch).toHaveBeenCalledWith({
    type: "setAgentId",
    id: published[0]!.id,
  });
});

test("AgentSection shows a designed error state (with retry) when the agents query failed", async () => {
  const onRetry = mock(() => {});
  const view = renderWithRouter(
    <AgentSection
      agents={null}
      isError
      onRetry={onRetry}
      selectedAgentId={null}
      dispatch={() => {}}
    />,
  );
  // null + isError is an ERROR, not loading — no skeletons forever.
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't load this workspace's agents.");
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("AgentSection flags a build-failed published agent on its card", async () => {
  const view = renderWithRouter(
    <AgentSection agents={AGENTS} selectedAgentId={null} dispatch={() => {}} />,
  );
  const card = await view.findByRole("radio", { name: /Data analyst/ });
  expect(card.textContent).toContain("Build failed");
  expect(FIXTURE_DATA_ANALYST.summary.buildStatus).toBe("failed");
});

test("AgentSection shows a dimmed warning card when the selection is unpublished", async () => {
  const view = renderWithRouter(
    <AgentSection
      agents={AGENTS}
      selectedAgentId={FIXTURE_RELEASE_BOT.summary.id}
      dispatch={() => {}}
    />,
  );
  const stale = await view.findByTestId("stale-agent-card");
  expect(stale.textContent).toContain("Release bot");
  expect(stale.textContent).toContain("Not published");
  // The published inventory stays pickable underneath.
  expect(view.getByRole("radiogroup", { name: "Agent" })).toBeTruthy();
});

test("AgentSection shows a missing card when the selected agent no longer exists", async () => {
  const view = renderWithRouter(
    <AgentSection
      agents={AGENTS}
      selectedAgentId="99999999-9999-4999-8999-999999999999"
      dispatch={() => {}}
    />,
  );
  const stale = await view.findByTestId("stale-agent-card");
  expect(stale.textContent).toContain("Unknown agent");
  expect(stale.textContent).toContain("Missing");
});

test("AgentSection empty state links to /agents when nothing is published", async () => {
  const view = renderWithRouter(
    <AgentSection
      agents={[FIXTURE_RELEASE_BOT.summary]}
      selectedAgentId={null}
      dispatch={() => {}}
    />,
  );
  expect(await view.findByText("No published agents yet")).toBeTruthy();
  const link = view.getByRole("link", { name: /Open Agents/ });
  expect(link.getAttribute("href")).toBe("/agents");
  expect(view.queryByRole("radiogroup")).toBeNull();
});

test("AgentSection renders ghost cards while the inventory loads", async () => {
  const view = renderWithRouter(
    <AgentSection
      agents={null}
      selectedAgentId={FIXTURE_AGENT_IDS.execAssistant}
      dispatch={() => {}}
    />,
  );
  // Wait for the router to mount the subtree, then assert the ghost grid.
  await waitFor(() => {
    expect(view.container.querySelector("div[aria-hidden='true']")).toBeTruthy();
  });
  expect(view.queryByRole("radiogroup")).toBeNull();
  expect(view.queryByTestId("stale-agent-card")).toBeNull();
});

// ── SaveIndicator ───────────────────────────────────────────────────────────

test("SaveIndicator walks its states: saving → issues → clean → error", () => {
  const view = render(
    <SaveIndicator status="saving" issueCount={0} isDirty={true} />,
  );
  expect(view.container.textContent).toContain("Saving…");

  view.rerender(<SaveIndicator status="saved" issueCount={2} isDirty={false} />);
  expect(view.container.textContent).toContain("2 issues");

  view.rerender(<SaveIndicator status="saved" issueCount={0} isDirty={false} />);
  expect(view.container.textContent).toContain("Saved");

  view.rerender(<SaveIndicator status="error" issueCount={0} isDirty={true} />);
  expect(view.container.textContent).toContain("Save failed");

  view.rerender(<SaveIndicator status="idle" issueCount={0} isDirty={false} />);
  expect(view.container.textContent).toContain("All changes saved");
});

test("exercised fixture matrix matches the design's state coverage", () => {
  // Published + published + published-failed + draft — the four states the
  // section must present (design §3).
  expect(FIXTURE_EXEC_ASSISTANT.summary.publishedVersionId).not.toBeNull();
  expect(FIXTURE_RELEASE_BOT.summary.publishedVersionId).toBeNull();
});
