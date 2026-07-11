/**
 * TestRunPopover tests (happy-dom): per-trigger-type bodies, payload
 * assembly through the `runFn` seam ({message} vs {data} vs {}), form-field
 * coercion, the publish-first gate on dirty/unpublished drafts, inline
 * submit errors, and the success receipt's "View in Chat" hand-off.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { TriggerConfig } from "@invisible-string/shared";

import {
  collectFormData,
  TestRunPopover,
  type TestRunPopoverProps,
} from "../components/builder/TestRunPopover";
import { ToastProvider } from "../components/ui/Toast";
import { ApiError } from "../lib/api-client";
import { renderWithRouter } from "../test/router";

ensureDomForThisFile();
afterEach(cleanup);

const q = () => within(document.body);

function okRunFn() {
  return mock(async () => ({ runId: "run-1", sessionId: "session-1" }));
}

function baseProps(
  overrides: Partial<TestRunPopoverProps> = {},
): TestRunPopoverProps {
  return {
    workspaceId: "ws-1",
    workflowId: "wf-1",
    trigger: { type: "manual" },
    isPublished: true,
    isDirty: false,
    canPublish: true,
    publishPending: false,
    onPublish: () => {},
    runFn: okRunFn(),
    ...overrides,
  };
}

async function openPopover(props: TestRunPopoverProps) {
  const view = renderWithRouter(
    <ToastProvider>
      <TestRunPopover {...props} />
    </ToastProvider>,
  );
  const trigger = await view.findByRole("button", { name: /Run/ });
  fireEvent.click(trigger);
  return view;
}

function submitForm() {
  const form = document.body.querySelector("form");
  if (!form) throw new Error("popover form not open");
  fireEvent.submit(form);
}

// ── payload assembly per trigger type ───────────────────────────────────────

test("manual trigger: requires a message, then posts {message} and offers View in Chat", async () => {
  const runFn = okRunFn();
  await openPopover(baseProps({ runFn }));

  // Empty message → inline error, nothing dispatched.
  submitForm();
  expect(q().getByRole("alert").textContent).toContain("Write a message");
  expect(runFn).not.toHaveBeenCalled();

  fireEvent.input(q().getByLabelText("Message"), {
    target: { value: "  Summarize yesterday's tickets  " },
  });
  submitForm();

  await waitFor(() => expect(q().getByTestId("run-started")).toBeTruthy());
  // Trimmed message body through the real dispatch path.
  expect(runFn).toHaveBeenCalledWith("ws-1", "wf-1", {
    message: "Summarize yesterday's tickets",
  });
  const chatLink = q().getByRole("link", { name: /View in Chat/ });
  expect(chatLink.getAttribute("href")).toBe("/chat");
});

test("webhook trigger: rejects invalid and non-object JSON, then posts {data}", async () => {
  const runFn = okRunFn();
  await openPopover(
    baseProps({ trigger: { type: "webhook" }, runFn }),
  );

  const payload = q().getByLabelText("JSON payload");
  fireEvent.input(payload, { target: { value: "{ nope" } });
  submitForm();
  expect(q().getByRole("alert").textContent).toContain("valid JSON");

  fireEvent.input(payload, { target: { value: '["array"]' } });
  submitForm();
  expect(q().getByRole("alert").textContent).toContain("JSON object");
  expect(runFn).not.toHaveBeenCalled();

  fireEvent.input(payload, {
    target: { value: '{"ticket": "T-42", "priority": 2}' },
  });
  submitForm();
  await waitFor(() => expect(q().getByTestId("run-started")).toBeTruthy());
  expect(runFn).toHaveBeenCalledWith("ws-1", "wf-1", {
    data: { ticket: "T-42", priority: 2 },
  });
});

test("form trigger: renders the designed schema as real inputs and posts coerced {data}", async () => {
  const runFn = okRunFn();
  const trigger: TriggerConfig = {
    type: "form",
    fields: [
      { key: "email", label: "Email", type: "text", required: true },
      { key: "seats", label: "Seats", type: "number", required: false },
      { key: "urgent", label: "Urgent", type: "checkbox", required: false },
    ],
  };
  await openPopover(baseProps({ trigger, runFn }));

  fireEvent.input(q().getByLabelText("Email"), {
    target: { value: "ada@example.com" },
  });
  fireEvent.input(q().getByLabelText("Seats"), { target: { value: "3" } });
  submitForm();

  await waitFor(() => expect(q().getByTestId("run-started")).toBeTruthy());
  // number coerced, unchecked checkbox posted as false, no empty keys.
  expect(runFn).toHaveBeenCalledWith("ws-1", "wf-1", {
    data: { email: "ada@example.com", seats: 3, urgent: false },
  });
});

test("form trigger with no fields shows the designed empty hint", async () => {
  await openPopover(
    baseProps({ trigger: { type: "form", fields: [] } }),
  );
  expect(q().getByText(/no fields yet/)).toBeTruthy();
});

test("schedule trigger: no payload inputs, Fire now posts an empty body", async () => {
  const runFn = okRunFn();
  await openPopover(
    baseProps({ trigger: { type: "schedule", cron: "0 9 * * 1" }, runFn }),
  );
  expect(q().queryByLabelText("Message")).toBeNull();
  expect(q().getByRole("button", { name: /Fire now/ })).toBeTruthy();
  submitForm();
  await waitFor(() => expect(q().getByTestId("run-started")).toBeTruthy());
  expect(runFn).toHaveBeenCalledWith("ws-1", "wf-1", {});
});

// ── publish-first gate ──────────────────────────────────────────────────────

test("a never-published workflow gets the publish-first note and a disabled submit", async () => {
  const runFn = okRunFn();
  const onPublish = mock(() => {});
  await openPopover(
    baseProps({ isPublished: false, isDirty: true, runFn, onPublish }),
  );

  const note = q().getByTestId("publish-first");
  expect(note.textContent).toContain("Publish this workflow first");
  const submit = q().getByRole("button", { name: /Start run/ });
  expect((submit as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(q().getByRole("button", { name: /Publish now/ }));
  expect(onPublish).toHaveBeenCalled();
});

test("unpublished EDITS phrase the note differently and respect canPublish", async () => {
  await openPopover(
    baseProps({ isPublished: true, isDirty: true, canPublish: false }),
  );
  const note = q().getByTestId("publish-first");
  expect(note.textContent).toContain("unpublished changes");
  const publishNow = q().getByRole("button", { name: /Publish now/ });
  expect((publishNow as HTMLButtonElement).disabled).toBe(true);
});

// ── failure surface ─────────────────────────────────────────────────────────

test("a dispatch failure surfaces the ApiError message inline", async () => {
  const runFn = mock(async () => {
    throw new ApiError(409, "workflow_disabled", "This workflow is paused.");
  });
  await openPopover(baseProps({ runFn: runFn as never }));
  fireEvent.input(q().getByLabelText("Message"), {
    target: { value: "go" },
  });
  submitForm();
  await waitFor(() =>
    expect(q().getByRole("alert").textContent).toContain(
      "This workflow is paused.",
    ),
  );
  expect(q().queryByTestId("run-started")).toBeNull();
});

// ── collectFormData coercion ────────────────────────────────────────────────

test("collectFormData coerces numbers/checkboxes and drops empty values", () => {
  const fields = [
    { key: "email", label: "Email", type: "text", required: true },
    { key: "seats", label: "Seats", type: "number", required: false },
    { key: "urgent", label: "Urgent", type: "checkbox", required: false },
    { key: "notes", label: "Notes", type: "textarea", required: false },
  ] as const;
  expect(
    collectFormData(fields as never, {
      email: "ada@example.com",
      seats: "12",
      urgent: true,
      notes: "",
    }),
  ).toEqual({ email: "ada@example.com", seats: 12, urgent: true });
});
