/**
 * THE PHASE-4 ACCEPTANCE (docs/PLAN.md Phase 4, INITIAL-SPEC §12) through the
 * real browser + stack, with the control-plane's copilot on the scripted fake
 * LLM (COPILOT_FAKE_SCRIPT — see support/copilot-script.ts; no real model is
 * ever called here).
 *
 * Spec 1 — scaffold from a one-liner: sign in → seed a connection → fresh
 * workflow → copilot rail → send the one-liner → the copilot proposes
 * setTrigger(form, 2 fields) → addContext(seeded connection) →
 * setInstructions(@trigger ref + @connection ref), each as an Apply/Dismiss
 * suggestion card; Apply all three (asserting the pillar rail cards update
 * live and the instructions card renders a real diff preview) → Publish
 * (real eve build → READY) → run it from chat (eve mock model) → the working
 * block streams and completes.
 *
 * Spec 2 — edit an existing workflow: the copilot proposes an instructions
 * diff AND a trigger change; Apply the first, DISMISS the second; the
 * dismissed change never touches the draft (rail + reload), and the model
 * verifiably received the rejection (the scripted fake's closing message
 * echoes the tool-result outcomes it was fed).
 */
import { expect, test, type Page } from "@playwright/test";

import { addCustomConnection } from "../support/authoring.ts";
import {
  focusPillar,
  openNewWorkflow,
  publishAndWaitReady,
  startChatAndSend,
  writePlainInstructions,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import {
  EDIT_BASE_INSTRUCTIONS,
  EDIT_DISMISSED_CRON,
  EDIT_PROMPT,
  SCAFFOLD_CONNECTION_NAME,
  SCAFFOLD_PROMPT,
} from "../support/copilot-script.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

/**
 * Open the docked copilot rail and send `message` through its composer.
 * The dock's socket connects lazily on open and drops frames sent before the
 * handshake completes, so the click is retried until the user bubble renders —
 * retries are safe no-ops after a successful send (the composer clears and
 * the send button disables).
 */
async function openCopilotAndSend(page: Page, message: string): Promise<void> {
  await page.getByRole("button", { name: "Open Copilot" }).click();
  const dock = page.getByRole("complementary", { name: "Copilot" });
  await expect(dock).toBeVisible();
  await dock.getByRole("textbox", { name: "Ask copilot" }).fill(message);
  const sendButton = dock.getByRole("button", { name: "Send to copilot" });
  const userBubble = dock.getByText(message, { exact: true });
  await expect(async () => {
    await sendButton.click();
    await expect(userBubble).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/** The pillar rail card (live summary) for a pillar. */
function railCard(page: Page, pillar: "Trigger" | "Context" | "Instructions") {
  return page
    .getByRole("navigation", { name: "Workflow pillars" })
    .getByRole("button", { name: new RegExp(`^${pillar}`) });
}

test("copilot scaffolds a runnable workflow from a one-liner", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "copilot");

  // The workspace resource the scripted copilot will attach by inventory id.
  await addCustomConnection(page, { name: SCAFFOLD_CONNECTION_NAME });

  await openNewWorkflow(page, "Copilot scaffold workflow");
  await expect(railCard(page, "Trigger")).toContainText("Manual");

  await openCopilotAndSend(page, SCAFFOLD_PROMPT);

  // ── suggestion 1: form trigger with two fields ──────────────────────────────
  const triggerCard = page.getByRole("group", {
    name: /^Suggestion: Set trigger: Form/,
  });
  await expect(triggerCard).toBeVisible();
  // Structured before → after preview on the card.
  await expect(triggerCard.getByTestId("before-after")).toContainText(
    "Form · 2 fields",
  );
  await triggerCard.getByRole("button", { name: "Apply" }).click();
  // The pillar rail card updates LIVE from the applied mutation.
  await expect(railCard(page, "Trigger")).toContainText("Form");
  await expect(railCard(page, "Trigger")).toContainText("2 fields");

  // ── suggestion 2: attach the seeded connection ──────────────────────────────
  const contextCard = page.getByRole("group", {
    name: `Suggestion: Add connection: ${SCAFFOLD_CONNECTION_NAME}`,
  });
  await expect(contextCard).toBeVisible();
  await contextCard.getByRole("button", { name: "Apply" }).click();
  await expect(railCard(page, "Context")).toContainText(
    SCAFFOLD_CONNECTION_NAME,
  );

  // ── suggestion 3: instructions with a valid @trigger reference ─────────────
  const instructionsCard = page.getByRole("group", {
    name: "Suggestion: Write instructions",
  });
  await expect(instructionsCard).toBeVisible();
  // The instructions proposal renders an inline DIFF preview (all additions
  // against the empty draft), including the @trigger reference line.
  const diff = instructionsCard.getByTestId("diff-view");
  await expect(diff).toBeVisible();
  await expect(diff.locator('[data-diff="add"]').first()).toBeVisible();
  await expect(diff).toContainText("@trigger.email");
  await instructionsCard.getByRole("button", { name: "Apply" }).click();
  await expect(railCard(page, "Instructions")).toContainText(
    "Triage each form submission",
  );

  // Three applied receipts + the copilot's closing prose. Scoped to the
  // thread log — the dock's sr-only announcer repeats settled messages.
  await expect(
    page.getByTestId("suggestion-receipt").filter({ hasText: "Applied" }),
  ).toHaveCount(3);
  const thread = page.getByRole("log", { name: "Copilot conversation" });
  await expect(thread.getByText("Publish when ready")).toBeVisible();

  // ── publish (real eve build) → READY ────────────────────────────────────────
  await publishAndWaitReady(page);

  // ── run it from chat (eve mock model) → working block completes ────────────
  await startChatAndSend(
    page,
    "Copilot scaffold workflow",
    "Make a todo list for the triage steps, then summarize the plan.",
  );
  const workingBlock = page.getByRole("button", { name: /Work(ing|ed)/ });
  await expect(workingBlock).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  const collapsed = page.getByRole("button", { name: /Worked/ });
  await expect(collapsed).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await expect(page.getByText(/Worked for \d+s · \d+ step/)).toBeVisible();
  await expect(page.getByText(/Used todo/i).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
});

test("copilot edit: apply one suggestion, dismiss the other — the dismissal never touches the draft and reaches the model", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "copilot-edit");

  // An existing workflow: manual trigger + real instructions.
  await openNewWorkflow(page, "Copilot edit workflow");
  await writePlainInstructions(page, EDIT_BASE_INSTRUCTIONS);
  await expect(railCard(page, "Trigger")).toContainText("Manual");

  await openCopilotAndSend(page, EDIT_PROMPT);

  // ── proposal 1: instructions diff — APPLY ───────────────────────────────────
  const instructionsCard = page.getByRole("group", {
    name: "Suggestion: Rewrite instructions",
  });
  await expect(instructionsCard).toBeVisible();
  const diff = instructionsCard.getByTestId("diff-view");
  await expect(diff).toBeVisible();
  await expect(diff.locator('[data-diff="add"]').last()).toContainText(
    "explicit approval",
  );
  await instructionsCard.getByRole("button", { name: "Apply" }).click();
  // Applied through the builder controller: the CodeMirror editor shows it.
  await expect(
    page.getByRole("textbox", { name: "Instructions editor" }),
  ).toContainText("explicit approval");

  // ── proposal 2: schedule trigger — DISMISS ──────────────────────────────────
  const scheduleCard = page.getByRole("group", {
    name: /^Suggestion: Set trigger: Schedule/,
  });
  await expect(scheduleCard).toBeVisible();
  await expect(scheduleCard.getByTestId("before-after")).toContainText(
    EDIT_DISMISSED_CRON,
  );
  await scheduleCard.getByRole("button", { name: "Dismiss" }).click();
  await expect(
    page.getByTestId("suggestion-receipt").filter({ hasText: "Dismissed" }),
  ).toContainText("Set trigger: Schedule");

  // The dismissed mutation did NOT touch the draft.
  await expect(railCard(page, "Trigger")).toContainText("Manual");
  await expect(railCard(page, "Trigger")).not.toContainText("Schedule");

  // The model received both outcomes as tool results — the scripted fake's
  // closing message echoes them verbatim. Scoped to the thread log — the
  // dock's sr-only announcer repeats settled messages.
  const thread = page.getByRole("log", { name: "Copilot conversation" });
  await expect(
    thread.getByText(/setInstructions: accepted — the user applied/),
  ).toBeVisible();
  await expect(
    thread.getByText(/setTrigger: rejected — the user dismissed this proposal/),
  ).toBeVisible();

  // Persisted state agrees: after autosave + reload, the applied instructions
  // survive and the trigger is still Manual.
  await expect(page.getByText("Unsaved", { exact: true })).toBeHidden();
  await page.reload();
  await expect(railCard(page, "Trigger")).toContainText("Manual");
  await expect(railCard(page, "Trigger")).not.toContainText("Schedule");
  await focusPillar(page, "Instructions");
  await expect(
    page.getByRole("textbox", { name: "Instructions editor" }),
  ).toContainText("explicit approval");
});
