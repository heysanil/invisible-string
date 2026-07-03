/**
 * THE PHASE-2 ACCEPTANCE (docs/PLAN.md Phase 2 §Acceptance), entirely through
 * the builder UI against the real stack:
 *
 *   sign in → author a skill (with a file attachment) in /context → install a
 *   registry MCP connection (registry browser, network-stubbed) + add a
 *   custom-URL MCP connection (→ the local stub server) → build a workflow:
 *   form trigger with 2 fields, attach both connections + the skill, balanced
 *   agent preset, instructions typed with a real `@` autocomplete pick of
 *   @trigger.<field> → Publish (real eve build; wait for the ready chip) →
 *   start a chat session from the workflow → send a message → the WORKING
 *   BLOCK streams live steps then collapses with duration text → the final
 *   prose renders.
 *
 * One serial test: it is a single user story and the stack runs one agent.
 */
import { expect, test } from "@playwright/test";

import {
  addCustomConnection,
  createSkillWithAttachment,
  installRegistryConnection,
} from "../support/authoring.ts";
import {
  attachResource,
  openNewWorkflow,
  publishAndWaitReady,
  setFormTriggerWithTwoFields,
  startChatAndSend,
  writeInstructionsWithTriggerRef,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

const REGISTRY_CONNECTION = "Registry notes";
const CUSTOM_CONNECTION = "notes";
// Deliberately unrelated to the run message so the mock model's skill matcher
// never intercepts the tool call we want to exercise.
const SKILL_NAME = "Brand voice";

test("build a form-trigger workflow in the UI, publish, and run it from chat", async ({
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

  // ── build the workflow in the builder ──────────────────────────────────────
  // Stable name + config → a stable content hash, so a second consecutive run
  // hits the build cache (each spec runs in its own fresh workspace, so the
  // name never collides within a run).
  const workflowName = "Acceptance form workflow";
  await openNewWorkflow(page, workflowName);

  await setFormTriggerWithTwoFields(page, [
    { key: "email", label: "Customer email" },
    { key: "topic", label: "Topic" },
  ]);

  await attachResource(page, "connection", REGISTRY_CONNECTION);
  await attachResource(page, "connection", CUSTOM_CONNECTION);
  await attachResource(page, "skill", SKILL_NAME);

  await writeInstructionsWithTriggerRef(page, {
    lead: "You help triage requests. Note the sender ",
    triggerField: "email",
  });

  await publishAndWaitReady(page);

  // ── run it from a fresh chat session ───────────────────────────────────────
  // The published agent really connects to both MCP servers at session start
  // (the stub logs the initialize + tools/list handshakes). We drive the run
  // with a tool the eve MOCK model can invoke directly: eve exposes its
  // built-in tools (todo, read_file, …) to the top-level model, while MCP
  // connection tools sit behind eve's `connection_search` sub-agent — which
  // the deterministic mock never delegates to. `todo` yields a real streamed
  // tool step + a prose reply, exactly exercising the working-block UI.
  await startChatAndSend(
    page,
    workflowName,
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
});
