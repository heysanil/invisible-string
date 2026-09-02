/**
 * DOM smoke tests for the workflow shell's retained plain-React pieces — they
 * mount without crashing and route user intent to the reducer. (The Tiptap
 * editors are exercised by their pure @-source tests instead; the per-kind
 * step forms by pipeline-inspector.test.tsx.)
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { WorkflowConfig } from "@invisible-string/shared";

import { SaveIndicator } from "../components/builder/SaveIndicator";
import { TriggerEditor } from "../components/builder/TriggerEditor";

ensureDomForThisFile();
afterEach(cleanup);

function definition(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    version: 2,
    trigger: { type: "manual" },
    steps: [],
    overlap: "skip",
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
