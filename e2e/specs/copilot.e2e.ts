/**
 * COPILOT ACCEPTANCE through the real browser + stack, with the
 * control-plane's copilot on the scripted fake LLM (COPILOT_FAKE_SCRIPT —
 * see support/copilot-script.ts; no real model is ever called here). The
 * copilot is surface-aware: the workflow editor gets the
 * setTrigger/setAgent/setInstructions toolset, the agent editor gets
 * setPersona/setModel/add-removeContext.
 *
 * Spec 1 — scaffold a workflow from a one-liner: the copilot proposes
 * setTrigger(form, 2 fields) → setAgent(the seeded "General Purpose" agent,
 * resolved from the prompt inventory by the scripted fake exactly as a real
 * model would) → setInstructions(@trigger refs) — each an Apply/Dismiss
 * suggestion card. Applying flashes the target SECTION (the single-column
 * editor's live surface — the pillar rail is gone) and mutates the draft in
 * place; the instructions card renders a real diff preview. Then Publish
 * (INSTANT) and fire it through the Run popover → the delegated run streams
 * a working block in Chat.
 *
 * Spec 2 — edit an existing workflow: the copilot proposes an instructions
 * diff AND a trigger change; Apply the first, DISMISS the second; the
 * dismissed change never touches the draft (live sections + reload), and the
 * model verifiably received the rejection (the scripted fake's closing
 * message echoes the tool-result outcomes it was fed).
 *
 * Spec 3 — the agent editor surface: the copilot proposes a setPersona
 * mutation, rendered as a diff card; applying it lands in the persona
 * editor and flashes the rail's Persona card. Cheap by design: no publish,
 * no build.
 */
import { expect, test } from "@playwright/test";

import {
  openNewAgent,
  openNewWorkflow,
  publishWorkflow,
  runWorkflowFromHeader,
  startChatAndSend,
  waitForAgentPublished,
  writePlainInstructions,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import {
  EDIT_BASE_INSTRUCTIONS,
  EDIT_DISMISSED_CRON,
  EDIT_PROMPT,
  PERSONA_PROMPT,
  SCAFFOLD_AGENT_NAME,
  SCAFFOLD_PROMPT,
} from "../support/copilot-script.ts";
import {
  agentRailCard,
  expectWorkflowSectionFlash,
  openCopilotAndSend,
  workflowSection,
} from "../support/copilot.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

test("copilot scaffolds a runnable delegation from a one-liner", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "copilot");

  // The scripted setAgent proposal targets the seeded "General Purpose"
  // agent, which every fresh workspace auto-publishes in the background —
  // wait for its build so the proposal validates AND the final run can
  // dispatch. (This wait is also the seeded-auto-publish proof.)
  await waitForAgentPublished(page, SCAFFOLD_AGENT_NAME);

  await openNewWorkflow(page, "Copilot scaffold workflow");
  const triggerTypes = page.getByRole("radiogroup", { name: "Trigger type" });
  await expect(triggerTypes.getByRole("radio", { name: "Manual" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

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
  // The applied mutation flashes its section and lands in the live editor.
  await expectWorkflowSectionFlash(page, "trigger");
  await expect(triggerTypes.getByRole("radio", { name: "Form" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByPlaceholder("key")).toHaveCount(2);

  // ── suggestion 2: delegate to the seeded published agent ────────────────────
  const agentCard = page.getByRole("group", {
    name: `Suggestion: Set agent: ${SCAFFOLD_AGENT_NAME}`,
  });
  await expect(agentCard).toBeVisible();
  await agentCard.getByRole("button", { name: "Apply" }).click();
  await expectWorkflowSectionFlash(page, "agent");
  await expect(
    workflowSection(page, "agent")
      .getByRole("radiogroup", { name: "Agent" })
      .getByRole("radio", { name: new RegExp(`^${SCAFFOLD_AGENT_NAME}\\b`) }),
  ).toHaveAttribute("aria-checked", "true");

  // ── suggestion 3: instructions with valid @trigger references ──────────────
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
  await expectWorkflowSectionFlash(page, "instructions");
  await expect(
    page.getByRole("textbox", { name: "Instructions editor" }),
  ).toContainText("Triage each form submission");

  // Three applied receipts + the copilot's closing prose. Scoped to the
  // thread log — the dock's sr-only announcer repeats settled messages.
  await expect(
    page.getByTestId("suggestion-receipt").filter({ hasText: "Applied" }),
  ).toHaveCount(3);
  const thread = page.getByRole("log", { name: "Copilot conversation" });
  await expect(thread.getByText("Publish when ready")).toBeVisible();

  // ── publish (INSTANT) and fire it through the Run popover ──────────────────
  await publishWorkflow(page);
  await runWorkflowFromHeader(page, {
    formValues: {
      "Customer email": "casey@acme.dev",
      Message: "Make a todo list for the triage steps.",
    },
  });

  // The delegated run streams in Chat (eve mock model → todo working block).
  await page.goto("/chat");
  const sessions = page.locator('[aria-label="Chat sessions"]');
  await sessions
    .getByRole("button", { name: new RegExp(SCAFFOLD_AGENT_NAME) })
    .first()
    .click();
  const workingBlock = page.getByRole("button", { name: /Work(ing|ed)/ });
  await expect(workingBlock.first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });
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
  const triggerTypes = page.getByRole("radiogroup", { name: "Trigger type" });
  await expect(triggerTypes.getByRole("radio", { name: "Manual" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

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

  // The dismissed mutation did NOT touch the draft — the live Trigger section
  // still shows Manual.
  await expect(triggerTypes.getByRole("radio", { name: "Manual" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(triggerTypes.getByRole("radio", { name: "Schedule" })).toHaveAttribute(
    "aria-checked",
    "false",
  );

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
  await expect(page.getByText("Saving…")).toBeHidden();
  await page.reload();
  await expect(
    page
      .getByRole("radiogroup", { name: "Trigger type" })
      .getByRole("radio", { name: "Manual" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("textbox", { name: "Instructions editor" }),
  ).toContainText("explicit approval");
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
