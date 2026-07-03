/**
 * HITL round-trip through the chat UI: a run parks on an inline
 * approval/question card (`input.requested`); responding to it resumes the run
 * to completion — exercising POST /runs/:id/input through the UI.
 *
 * The workflow is built with a real MCP connection whose approval policy is set
 * to "Always ask" (exercising the builder's per-connection approval UI). The
 * RUN itself parks via eve's `ask_question` tool: eve's deterministic mock
 * model exposes its built-in tools to the top-level model but routes MCP
 * connection tools behind a `connection_search` sub-agent it never delegates
 * to, so a gated *MCP* call can't be mock-driven — `ask_question` produces the
 * same `input.requested` park + resume path (and the same POST /runs/:id/input
 * round-trip) with the mock, which is what this spec verifies end-to-end.
 */
import { expect, test } from "@playwright/test";

import { addCustomConnection } from "../support/authoring.ts";
import {
  attachResource,
  openNewWorkflow,
  publishAndWaitReady,
  setConnectionApproval,
  startChatAndSend,
  writePlainInstructions,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

const CONNECTION = "notes";

test("a run parks on an inline HITL card, then responding resumes it", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "approval");
  await addCustomConnection(page, { name: CONNECTION });

  const workflowName = "Approval gated workflow";
  await openNewWorkflow(page, workflowName);

  // Manual trigger (the default) is fine. Attach the connection and gate it
  // behind approval — exercises the per-connection approval-policy UI.
  await attachResource(page, "connection", CONNECTION);
  await setConnectionApproval(page, CONNECTION, "Always ask");
  await writePlainInstructions(
    page,
    "Confirm with the user before doing anything irreversible.",
  );

  await publishAndWaitReady(page);

  await startChatAndSend(
    page,
    workflowName,
    "Use the ask_question tool to confirm with me before continuing.",
  );

  // The run parks on an inline HITL card awaiting a response.
  const card = page.getByRole("group", { name: "Approval requested" });
  await expect(card).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  // While parked, the composer tells the user their input is needed.
  await expect(page.getByText(/Waiting for your approval/i)).toBeVisible();

  // Respond through the card → POST /runs/:id/input → the run resumes.
  await card.getByRole("textbox", { name: "Your response" }).fill("Yes, go ahead.");
  await card.getByRole("button", { name: "Send" }).click();

  // The card is dismissed and the run completes (composer re-enabled).
  await expect(card).toBeHidden({ timeout: RUN_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled({
    timeout: RUN_TIMEOUT_MS,
  });
});
