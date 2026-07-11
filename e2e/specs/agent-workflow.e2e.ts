/**
 * THE AGENTS-FIRST ACCEPTANCE, entirely through the UI against the real
 * stack (replaces the old workflow-form spec — the agent is the compile
 * unit now, workflows are a standing delegation):
 *
 *   sign in → author a skill (with a file attachment) in /context → install a
 *   registry MCP connection (registry browser, network-stubbed) + add a
 *   custom-URL MCP connection (→ the local stub server) → HIRE an agent in
 *   /agents: persona, balanced model preset, both connections + the skill
 *   attached → Publish (real eve build; wait for the ready chip) → CHAT with
 *   it via the "New chat" agent picker: the WORKING BLOCK streams live steps
 *   then collapses with duration text and the final prose renders → DELEGATE:
 *   build a form-trigger workflow bound to that agent, instructions typed
 *   with a real `@` autocomplete pick of @trigger.<field> → Publish (INSTANT
 *   — validate + snapshot, no build) → fire it through the header's Run
 *   popover (the real trigger-dispatch path) → the run lands in Chat with
 *   the workflow provenance chip, the RESOLVED @trigger value in the task
 *   message, and a streamed tool step.
 *
 * One serial test: it is a single user story and the stack runs one worker.
 */
import { expect, test } from "@playwright/test";

import {
  addCustomConnection,
  createSkillWithAttachment,
  installRegistryConnection,
} from "../support/authoring.ts";
import {
  appendInstructions,
  attachAgentResource,
  openNewAgent,
  openNewWorkflow,
  publishAgentAndWaitReady,
  publishWorkflow,
  runWorkflowFromHeader,
  selectWorkflowAgent,
  setAgentModelPreset,
  setFormTriggerWithTwoFields,
  startChatAndSend,
  writeInstructionsWithTriggerRef,
  writePersona,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

const REGISTRY_CONNECTION = "Registry notes";
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

test("hire an agent in the UI, publish + chat, then delegate a form workflow to it", async ({
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
  await installRegistryConnection(page, { name: REGISTRY_CONNECTION, query: "notes" });
  await addCustomConnection(page, { name: CUSTOM_CONNECTION });

  // ── hire the agent: persona · model · context ──────────────────────────────
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
  // The published agent really connects to both MCP servers at session start
  // (the stub logs the initialize + tools/list handshakes). We drive the run
  // with a tool the eve MOCK model can invoke directly: eve exposes its
  // built-in tools (todo, read_file, …) to the top-level model, while MCP
  // connection tools sit behind eve's `connection_search` sub-agent — which
  // the deterministic mock never delegates to. `todo` yields a real streamed
  // tool step + a prose reply, exactly exercising the working-block UI.
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

  // ── delegate: a form-trigger workflow bound to the agent ───────────────────
  await openNewWorkflow(page, WORKFLOW_NAME);
  await setFormTriggerWithTwoFields(page, [
    { key: "email", label: "Customer email" },
    { key: "topic", label: "Topic" },
  ]);
  await selectWorkflowAgent(page, AGENT_NAME);
  await writeInstructionsWithTriggerRef(page, {
    lead: "You help triage requests. Note the sender ",
    triggerField: "email",
  });
  // The todo directive makes the dispatched run drive a real streamed tool
  // step under the mock model. A space + blank line leads the text so the
  // newline lands cleanly after the trailing `@trigger.email` ref.
  await appendInstructions(
    page,
    " \n\nMake a todo list for the triage steps, then summarize the plan.",
  );

  // Publish is INSTANT — validate + snapshot; builds belong to the agent.
  await publishWorkflow(page);

  // ── fire it through the Run popover (the real trigger-dispatch path) ───────
  await runWorkflowFromHeader(page, {
    formValues: { "Customer email": FORM_EMAIL, Topic: "Password reset" },
  });

  // The run lands in Chat: newest session first (both sessions carry the
  // agent's name — the list isn't polled, so reload until the workflow-origin
  // one is on top with its provenance chip).
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
  // @trigger.email value (the control plane renders instructions at dispatch;
  // the agent never sees a TriggerEvent envelope).
  await expect(page.getByText(FORM_EMAIL).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });

  // And the delegated run streams like any other: working block + prose.
  await expect(
    page.getByRole("button", { name: /Work(ing|ed)/ }).first(),
  ).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await expect(page.getByText(/Used todo/i).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
});
