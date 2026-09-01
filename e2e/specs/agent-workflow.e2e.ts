/**
 * THE AGENTS-FIRST ACCEPTANCE, entirely through the UI against the real
 * stack (the agent is the compile unit; a workflow is a PIPELINE the control
 * plane interprets, and an AGENT STEP delegates to a published agent):
 *
 *   sign in → author a skill (with a file attachment) in /context → install a
 *   community MCP connection (add-connection dialog search lane, backed by
 *   the Meilisearch mirror of the stubbed registry) + add a custom-URL MCP
 *   connection (→ the local stub server) → BUILD an agent in
 *   /agents: persona, balanced model preset, both connections + the skill
 *   attached → Publish (real eve build; wait for the ready chip) → CHAT with
 *   it via the "New chat" agent picker: the WORKING BLOCK streams live steps
 *   then collapses with duration text and the final prose renders →
 *   DELEGATE: build a form-trigger PIPELINE whose single step is an agent
 *   step bound to that agent (added through the strip's Add-a-step menu; its
 *   instructions typed with a real `@` autocomplete pick of
 *   @trigger.<field>) → Publish (INSTANT — validate + snapshot, no build) →
 *   fire it through the header's Run popover (the real trigger-dispatch
 *   path: a pipeline run whose agent step spawns a CHILD run) → the child
 *   session lands in Chat with the workflow provenance chip, the RESOLVED
 *   @trigger value in the task message, and a streamed tool step — and the
 *   workflow's Runs tab renders the step timeline with the child transcript
 *   embedded in the agent step's drawer.
 *
 * One serial test: it is a single user story and the stack runs one worker.
 */
import { expect, test } from "@playwright/test";

import {
  addCustomConnection,
  createSkillWithAttachment,
  gotoSection,
  installRegistryConnection,
} from "../support/authoring.ts";
import {
  addFirstStep,
  appendAgentInstructions,
  attachAgentResource,
  openNewAgent,
  openNewWorkflow,
  openRunsTab,
  publishAgentAndWaitReady,
  publishWorkflow,
  runWorkflowFromHeader,
  selectWorkflowAgent,
  setAgentModelPreset,
  setFormTriggerWithTwoFields,
  startChatAndSend,
  writeAgentInstructionsWithTriggerRef,
  writePersona,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";
import { REGISTRY_SERVER_TITLE } from "../config.ts";

// Community installs are named after the server title (no name field in the
// add dialog), so the attached connection carries the stub server's title.
const REGISTRY_CONNECTION = REGISTRY_SERVER_TITLE;
const CUSTOM_CONNECTION = "notes";
// Deliberately unrelated to the run message so the mock model's skill matcher
// never intercepts the tool call we want to exercise.
const SKILL_NAME = "Brand voice";
// Stable names + config → a stable content hash, so a second consecutive run
// hits the build cache (each spec runs in its own fresh workspace, so names
// never collide within a run).
const AGENT_NAME = "Acceptance triage agent";
const WORKFLOW_NAME = "Acceptance form workflow";
const FORM_EMAIL = "jordan@acme.dev";

test("build an agent in the UI, publish + chat, then delegate a form pipeline to it", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "acceptance");

  // ── author context: a skill (with an attachment) + two MCP connections ─────
  await createSkillWithAttachment(page, {
    name: SKILL_NAME,
    description: "Use when the user asks about tone or writing style.",
    content: "# Brand voice\n\nWarm, concise, plain language.",
    fileName: "template.md",
  });
  await installRegistryConnection(page, { query: "notes" });
  await addCustomConnection(page, { name: CUSTOM_CONNECTION });

  // ── build the agent: persona · model · context ──────────────────────────────
  await openNewAgent(page, AGENT_NAME);
  await writePersona(
    page,
    "You triage inbound support requests: classify, plan, and draft warm concise replies.",
  );
  await setAgentModelPreset(page, "Balanced");
  await attachAgentResource(page, "connection", REGISTRY_CONNECTION);
  await attachAgentResource(page, "connection", CUSTOM_CONNECTION);
  await attachAgentResource(page, "skill", SKILL_NAME);

  // ── publish: the REAL eve build (the agent is the compile unit) ────────────
  await publishAgentAndWaitReady(page);

  // ── chat with it via the agent picker ──────────────────────────────────────
  // Under the mock model the published agent never even opens an MCP session
  // to the stub: MCP connections attach lazily through eve's
  // `connection_search` sub-agent, which the deterministic mock never
  // delegates to. So we drive the run with a tool the mock CAN invoke
  // directly — eve exposes its built-in tools (todo, read_file, …) to the
  // top-level model. `todo` yields a real streamed tool step + a prose
  // reply, exactly exercising the working-block UI.
  await startChatAndSend(
    page,
    AGENT_NAME,
    "Make a todo list for the triage steps, then summarize the plan.",
  );

  // The working block appears while the run streams (name "Working…"), then
  // auto-collapses to a "Worked for Ns · N steps" summary once it completes.
  const workingBlock = page.getByRole("button", { name: /Work(ing|ed)/ });
  await expect(workingBlock).toBeVisible({ timeout: RUN_TIMEOUT_MS });

  const collapsed = page.getByRole("button", { name: /Worked/ });
  await expect(collapsed).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await expect(collapsed).toHaveAttribute("aria-expanded", "false");
  // "Worked for Ns · N steps" — proves live steps streamed then folded.
  await expect(page.getByText(/Worked for \d+s · \d+ step/)).toBeVisible();

  // Expanding reveals the streamed tool step.
  await collapsed.click();
  await expect(page.getByText("todo", { exact: false }).first()).toBeVisible();

  // Final assistant prose is rendered below the working block.
  await expect(page.getByText(/Used todo/i).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });

  // ── delegate: a form-trigger pipeline with one agent step ──────────────────
  await openNewWorkflow(page, WORKFLOW_NAME);
  await setFormTriggerWithTwoFields(page, [
    { key: "email", label: "Customer email" },
    { key: "topic", label: "Topic" },
  ]);
  // The strip's designed empty state offers the Add-a-step menu inline; the
  // new agent step is auto-selected with its inspector open.
  await addFirstStep(page, "Agent");
  await selectWorkflowAgent(page, AGENT_NAME);
  await writeAgentInstructionsWithTriggerRef(page, {
    lead: "You help triage requests. Note the sender ",
    triggerField: "email",
  });
  // The todo directive makes the dispatched child run drive a real streamed
  // tool step under the mock model. A space + blank line leads the text so
  // the newline lands cleanly after the trailing `@trigger.email` ref.
  await appendAgentInstructions(
    page,
    " \n\nMake a todo list for the triage steps, then summarize the plan.",
  );

  // Publish is INSTANT — validate + snapshot; builds belong to the agent.
  await publishWorkflow(page);

  // ── fire it through the Run popover (the real trigger-dispatch path) ───────
  await runWorkflowFromHeader(page, {
    formValues: { "Customer email": FORM_EMAIL, Topic: "Password reset" },
  });

  // The agent step's CHILD session lands in Chat: newest session first (both
  // sessions carry the agent's name — the list isn't polled, so reload until
  // the workflow-origin one is on top with its provenance chip).
  const sessions = page.locator('[aria-label="Chat sessions"]');
  await expect(async () => {
    await page.goto("/chat");
    await sessions
      .getByRole("button", { name: new RegExp(AGENT_NAME) })
      .first()
      .click();
    // Workflow provenance chip in the thread header.
    await expect(page.getByText(WORKFLOW_NAME, { exact: true })).toBeVisible({
      timeout: 4_000,
    });
  }).toPass({ timeout: RUN_TIMEOUT_MS });

  // Dispatch-time rendering: the task message carries the RESOLVED
  // @trigger.email value (the control plane renders the agent step's
  // instructions against the pipeline scope; the agent never sees a
  // TriggerEvent envelope).
  await expect(page.getByText(FORM_EMAIL).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });

  // And the delegated child run streams like any other: working block + prose.
  await expect(
    page.getByRole("button", { name: /Work(ing|ed)/ }).first(),
  ).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await expect(page.getByText(/Used todo/i).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });

  // ── the Runs tab: the pipeline's own step timeline ─────────────────────────
  await gotoSection(page, "Workflows");
  await page
    .getByRole("button", { name: new RegExp(WORKFLOW_NAME) })
    .first()
    .click();
  await page.waitForURL(/\/workflows\/[^/]+$/);
  await openRunsTab(page);
  // The list currently shows the agent step's CHILD run too (its provenance
  // names the workflow, it sorts newest, and its rows wear the fallback
  // "pipeline trigger" glyph) — pick the PARENT run by excluding it. (The
  // header Run popover stamps "manual" provenance even on a form trigger.)
  await page
    .getByTestId("run-row")
    .filter({ hasNot: page.locator('[title="pipeline trigger"]') })
    .first()
    .click();
  // The parent pipeline run settles succeeded and the agent step reads Done.
  await expect(page.getByText("succeeded").first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  // The agent step's drawer embeds the child run's real chat rendering.
  await page
    .locator('[data-testid="step-card"][data-step-kind="agent"] button')
    .first()
    .click();
  await expect(page.getByTestId("child-run-thread")).toBeVisible({
    timeout: 30_000,
  });
});
