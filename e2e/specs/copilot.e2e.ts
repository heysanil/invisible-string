/**
 * COPILOT ACCEPTANCE through the real browser + stack, with the
 * control-plane's copilot on the scripted fake LLM (COPILOT_FAKE_SCRIPT —
 * see support/copilot-script.ts; no real model is ever called here). The
 * copilot is surface-aware: the workflow editor exposes the PIPELINE toolset
 * (setTrigger + addStep/updateStep/removeStep/moveStep + the two read
 * tools), the agent editor setPersona/setModel/add-removeContext.
 *
 * Spec 1 — THE PIPELINE STORY, conversational-first: from a one-liner the
 * copilot proposes setTrigger(form) → calls searchConnectionTools (a
 * server-executed read tool — the script only advances past it because the
 * round-trip really completed) → proposes two addSteps (a state cursor and a
 * save_note tool call on the workspace's stub-MCP connection). With
 * auto-apply switched OFF each proposal parks as an Apply/Dismiss card;
 * pending addSteps render dashed GHOST cards at their target strip position,
 * and Apply solidifies them into real step cards (the trigger apply flashes
 * the TriggerCard). Then: publish (INSTANT), fire through the header's Run
 * popover, follow "View run" to the step timeline (the same strip in run
 * density) and assert both steps ran — plus, outside the browser, that the
 * stub MCP server really received the note with the @trigger refs RESOLVED.
 *
 * Spec 2 — edit an existing published pipeline: allow-edits DEFAULTS OFF on
 * the published surface (and publishing mid-session must not flip a live
 * switch); the copilot proposes an addStep AND a trigger change in one turn.
 * Apply the first, DISMISS the second; the dismissed change never touches
 * the draft (live strip + reload), and the model verifiably received both
 * outcomes (the scripted fake's closing message echoes the tool results).
 *
 * Spec 3 — the agent editor surface keeps its docked rail: a setPersona
 * proposal renders as a diff card; applying lands in the persona editor and
 * the rail's Persona card. Cheap by design: no publish, no build.
 */
import { expect, test } from "@playwright/test";

import {
  addCustomConnection,
  waitForConnectionHealthy,
} from "../support/authoring.ts";
import {
  addFirstStep,
  openNewAgent,
  openNewWorkflow,
  publishWorkflow,
  runWorkflowFromHeader,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import {
  EDIT_ADDED_STEP_NAME,
  EDIT_DISMISSED_CRON,
  EDIT_PROMPT,
  PERSONA_PROMPT,
  SCAFFOLD_CONNECTION,
  SCAFFOLD_PROMPT,
  SCAFFOLD_STATE_STEP_NAME,
  SCAFFOLD_TOOL_STEP_NAME,
} from "../support/copilot-script.ts";
import {
  agentRailCard,
  openCopilotAndSend,
  sendWorkflowCopilotMessage,
  setAutoApply,
} from "../support/copilot.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";
import { REGISTRY_STUB_BASE_URL } from "../config.ts";

const FORM_EMAIL = "casey@acme.dev";
const FORM_MESSAGE = "Please reset my password";

test("copilot composes a pipeline from a one-liner: ghosts solidify, publish, run, step timeline", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "copilot");

  // The scripted tool step calls the stub server through the `notes`
  // connection — create it and wait for the probe's tools cache (the
  // `{{connectionId:notes}}` placeholder and the read tool both key off it).
  await addCustomConnection(page, { name: SCAFFOLD_CONNECTION });
  await waitForConnectionHealthy(page, SCAFFOLD_CONNECTION);

  await openNewWorkflow(page, "Copilot pipeline workflow");

  // Never-published draft ⇒ auto-apply defaults ON (surface-aware initial
  // value); switch it OFF so every proposal parks on the accept gate.
  await expect(
    page.getByRole("switch", { name: "Auto-apply edits" }),
  ).toHaveAttribute("aria-checked", "true");
  await setAutoApply(page, false);

  await sendWorkflowCopilotMessage(page, SCAFFOLD_PROMPT);

  // ── suggestion 1: form trigger with two fields ──────────────────────────────
  const triggerSuggestion = page.getByRole("group", {
    name: /^Suggestion: Set trigger: Form/,
  });
  await expect(triggerSuggestion).toBeVisible();
  await expect(triggerSuggestion.getByTestId("before-after")).toContainText(
    "Form · 2 fields",
  );
  await triggerSuggestion.getByRole("button", { name: "Apply" }).click();
  // The applied trigger flashes its card and updates the summary chip.
  await expect(
    page.locator('[data-testid="trigger-card"].pillar-flash'),
  ).toBeVisible({ timeout: 2_000 });
  await expect(page.getByTestId("trigger-card")).toContainText("Form");

  // ── suggestion 2 (after the read-tool round trip): the state step ──────────
  // A pending addStep renders a dashed ghost at its strip position.
  const stateSuggestion = page.getByRole("group", {
    name: `Suggestion: Add step: ${SCAFFOLD_STATE_STEP_NAME}`,
  });
  await expect(stateSuggestion).toBeVisible();
  const stateGhost = page
    .getByTestId("ghost-step-card")
    .filter({ hasText: SCAFFOLD_STATE_STEP_NAME });
  await expect(stateGhost).toBeVisible();
  await stateSuggestion.getByRole("button", { name: "Apply" }).click();
  // Ghost solidifies into the real card.
  await expect(stateGhost).toHaveCount(0);
  await expect(
    page.locator('[data-testid="step-card"][data-step-kind="state"]'),
  ).toBeVisible();

  // ── suggestion 3: the save_note tool step (head-inserted above the state) ──
  const toolSuggestion = page.getByRole("group", {
    name: `Suggestion: Add step: ${SCAFFOLD_TOOL_STEP_NAME}`,
  });
  await expect(toolSuggestion).toBeVisible();
  // Rich step preview: the args key-value table carries the template.
  await expect(toolSuggestion.getByTestId("args-diff")).toContainText(
    "@trigger.email",
  );
  const toolGhost = page
    .getByTestId("ghost-step-card")
    .filter({ hasText: SCAFFOLD_TOOL_STEP_NAME });
  await expect(toolGhost).toBeVisible();
  await toolSuggestion.getByRole("button", { name: "Apply" }).click();
  await expect(toolGhost).toHaveCount(0);
  const stepCards = page.getByTestId("step-card");
  await expect(stepCards).toHaveCount(2);
  // Execution order: the tool call first, then the state write.
  await expect(stepCards.nth(0)).toHaveAttribute("data-step-kind", "tool");
  await expect(stepCards.nth(1)).toHaveAttribute("data-step-kind", "state");

  // Three applied receipts + the copilot's closing prose, scoped to the
  // thread log (the sr-only announcer repeats settled messages).
  await expect(
    page.getByTestId("suggestion-receipt").filter({ hasText: "Applied" }),
  ).toHaveCount(3);
  const thread = page.getByRole("log", { name: "Copilot conversation" });
  await expect(thread.getByText("Publish when ready")).toBeVisible();

  // ── publish (INSTANT) and fire through the Run popover ─────────────────────
  await publishWorkflow(page);
  await runWorkflowFromHeader(page, {
    formValues: { "Customer email": FORM_EMAIL, Message: FORM_MESSAGE },
  });

  // ── the step timeline: the same strip in run density ───────────────────────
  // Two "View run" affordances render after a start (the popover's confirm
  // panel and the editor's run-overlay banner) — either leads to the run.
  await page.getByRole("link", { name: "View run" }).first().click();
  await page.waitForURL(/\/workflows\/[^/]+\/runs\/[^/]+$/);
  await expect(page.getByText("succeeded").first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  // Both steps report Done on their run-density cards.
  await expect(page.getByText("Done", { exact: true })).toHaveCount(2, {
    timeout: 30_000,
  });

  // Step drawer: the tool step's ledger instance with its persisted snapshot.
  await page
    .locator('[data-testid="step-card"][data-step-kind="tool"] button')
    .first()
    .click();
  const instance = page.getByTestId("step-instance");
  await expect(instance.first()).toBeVisible();
  await expect(instance.first()).toContainText("Done");
  await page.keyboard.press("Escape");

  // ── outside the browser: the stub MCP server really got the rendered call ──
  const calls = (await (
    await page.request.get(`${REGISTRY_STUB_BASE_URL}/__calls`)
  ).json()) as { calls: { name: string; args: { note?: string } }[] };
  const note = calls.calls.find(
    (call) =>
      call.name === "save_note" &&
      (call.args.note ?? "").includes(FORM_EMAIL) &&
      (call.args.note ?? "").includes(FORM_MESSAGE),
  );
  expect(note, "stub MCP never received the rendered save_note call").toBeTruthy();
});

test("copilot edit: apply one suggestion, dismiss the other — the dismissal never touches the draft and reaches the model", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "copilot-edit");

  // An existing PUBLISHED pipeline: manual trigger + one state step.
  await openNewWorkflow(page, "Copilot edit workflow");
  await addFirstStep(page, "State");
  await expect(page.getByText("Saving…")).toBeHidden();
  await publishWorkflow(page);

  // Publishing mid-session must not flip the live switch (it started ON for
  // the never-published draft)…
  await expect(
    page.getByRole("switch", { name: "Auto-apply edits" }),
  ).toHaveAttribute("aria-checked", "true");
  // …but a fresh mount of the PUBLISHED surface defaults it OFF.
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "Auto-apply edits" }),
  ).toHaveAttribute("aria-checked", "false");

  await sendWorkflowCopilotMessage(page, EDIT_PROMPT);

  // ── proposal 1: a new state step — APPLY ────────────────────────────────────
  const addCard = page.getByRole("group", {
    name: `Suggestion: Add step: ${EDIT_ADDED_STEP_NAME}`,
  });
  await expect(addCard).toBeVisible();
  await addCard.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByRole("button", {
      name: `${EDIT_ADDED_STEP_NAME} — State step`,
    }),
  ).toBeVisible();

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

  // The dismissed mutation did NOT touch the draft — the TriggerCard summary
  // still reads Manual.
  await expect(page.getByTestId("trigger-card")).toContainText("Manual");
  await expect(page.getByTestId("trigger-card")).not.toContainText("Schedule");

  // The model received both outcomes as tool results — the scripted fake's
  // closing message echoes them verbatim. Scoped to the thread log.
  const thread = page.getByRole("log", { name: "Copilot conversation" });
  await expect(
    thread.getByText(/addStep: accepted — the user applied/),
  ).toBeVisible();
  await expect(
    thread.getByText(/setTrigger: rejected — the user dismissed this proposal/),
  ).toBeVisible();

  // Persisted state agrees: after autosave + reload, the applied step
  // survives and the trigger is still Manual.
  await expect(page.getByText("Saving…")).toBeHidden();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: `${EDIT_ADDED_STEP_NAME} — State step`,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("trigger-card")).toContainText("Manual");
});

test("copilot on the agent surface: a setPersona diff card applies into the persona editor", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "copilot-agent");

  await openNewAgent(page, "Copilot persona agent");
  await openCopilotAndSend(page, PERSONA_PROMPT);

  // The persona proposal is a document mutation — it previews as a full diff.
  const personaCard = page.getByRole("group", {
    name: "Suggestion: Write persona",
  });
  await expect(personaCard).toBeVisible();
  const diff = personaCard.getByTestId("diff-view");
  await expect(diff).toBeVisible();
  await expect(diff.locator('[data-diff="add"]').first()).toBeVisible();
  await expect(diff).toContainText("support triage specialist");

  await personaCard.getByRole("button", { name: "Apply" }).click();
  // Applied through the agent controller: the persona editor shows it and
  // the rail's Persona card flashes + carries the live summary.
  await expect(page.getByRole("textbox", { name: "Persona" })).toContainText(
    "You are a support triage specialist.",
  );
  await expect(agentRailCard(page, "Persona")).toContainText(
    "You are a support triage specialist.",
  );
  await expect(
    page.getByTestId("suggestion-receipt").filter({ hasText: "Applied" }),
  ).toHaveCount(1);
  const thread = page.getByRole("log", { name: "Copilot conversation" });
  await expect(thread.getByText("Persona drafted", { exact: false })).toBeVisible();
});
