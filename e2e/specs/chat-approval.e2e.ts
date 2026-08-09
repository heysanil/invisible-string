/**
 * HITL round-trip through the chat UI: a run parks on an inline
 * approval/question card (`input.requested`); responding to it resumes the run
 * to completion — exercising POST /runs/:id/input through the UI. The tail of
 * the spec then exercises the eve 0.31 context controls on the settled
 * session (POST /sessions/:id/clear).
 *
 * The AGENT is equipped with a real MCP connection whose approval policy is
 * set to "Always ask" (exercising the agent editor's per-connection approval
 * UI — approval policy lives on the connection and applies everywhere it's
 * attached). The RUN itself parks via eve's `ask_question` tool: eve's
 * deterministic mock model exposes its built-in tools to the top-level model
 * but routes MCP connection tools behind a `connection_search` sub-agent it
 * never delegates to, so a gated *MCP* call can't be mock-driven —
 * `ask_question` produces the same `input.requested` park + resume path (and
 * the same POST /runs/:id/input round-trip) with the mock, which is what this
 * spec verifies end-to-end.
 *
 * NOTE on the card's accessible name: eve 0.31 stamps a `kind` discriminator
 * on every input request and the UI routes presentation on it, so an
 * `ask_question` park is a QUESTION ("Question from the agent"), not an
 * approval. That is the assertion that proves `kind` survives the whole path
 * — eve → tailer → run_events → SSE → reducer → ApprovalCard.
 */
import { expect, test } from "@playwright/test";

import { addCustomConnection } from "../support/authoring.ts";
import {
  attachAgentResource,
  openNewAgent,
  publishAgentAndWaitReady,
  setAgentConnectionApproval,
  startChatAndSend,
  writePersona,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

const CONNECTION = "notes";
const AGENT_NAME = "Approval gated agent";

test("a run parks on an inline HITL card, then responding resumes it; Stop and the context controls settle cleanly", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "approval");
  await addCustomConnection(page, { name: CONNECTION });

  // Build an agent, equip it with the connection, and gate the connection
  // behind approval — exercises the per-connection approval-policy UI.
  await openNewAgent(page, AGENT_NAME);
  await writePersona(
    page,
    "Confirm with the user before doing anything irreversible.",
  );
  await attachAgentResource(page, "connection", CONNECTION);
  await setAgentConnectionApproval(page, CONNECTION, "Always ask");

  await publishAgentAndWaitReady(page);

  await startChatAndSend(
    page,
    AGENT_NAME,
    "Use the ask_question tool to confirm with me before continuing.",
  );

  // The run parks on an inline HITL card awaiting a response. `ask_question`
  // carries eve 0.31's kind "question", so the card names itself as one.
  const card = page.getByRole("group", { name: "Question from the agent" });
  await expect(card).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  // Routing is explicit, not inferred: a question is not an approval.
  await expect(card).toHaveAttribute("data-input-kind", "question");
  // While parked, the composer tells the user their input is needed.
  await expect(page.getByText(/Waiting for your response/i)).toBeVisible();

  // Respond through the card → POST /runs/:id/input → the run resumes.
  await card.getByRole("textbox", { name: "Your response" }).fill("Yes, go ahead.");
  await card.getByRole("button", { name: "Send" }).click();

  // The card is dismissed and the run completes. The composer never disables
  // any more, so the completion signal is the SUBMIT BUTTON'S NAME: it reads
  // "Queue message" (or is replaced by Stop) exactly while the session's run
  // slot is held, and returns to "Send message" when the slot frees.
  await expect(card).toBeHidden({ timeout: RUN_TIMEOUT_MS });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });

  // ── eve 0.31 Stop ──────────────────────────────────────────────────────────
  // Park a second run and STOP it instead of answering. A parked run holds
  // the session's one run slot, so this is the deterministic long-lived state
  // the mock model can produce. The load-bearing assertion is that the run
  // settles as a stopped USER DECISION — neutral notice, and no error alert
  // anywhere — because eve emits `turn.cancelled` → `session.waiting` and no
  // failure event at all.
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Use the ask_question tool to check with me again.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(card).toBeVisible({ timeout: RUN_TIMEOUT_MS });

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText(/You stopped this run/)).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  // The stale request is retired with the turn — answering it would post a
  // dead requestId that eve replays to the model as ordinary text.
  await expect(card).toBeHidden();
  // Cancellation leaves the SESSION usable: the slot frees, so the submit
  // button goes back to being a send.
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });

  // ── eve 0.31 context controls ──────────────────────────────────────────────
  // Clear is non-destructive (the session id survives; only the agent's
  // durable model history is dropped), so it fires straight off the menu with
  // no confirm step. This proves POST /sessions/:id/clear → eve's
  // /eve/v1/session/:id/clear end to end through the worker proxy.
  await page.getByRole("button", { name: "Session actions" }).click();
  const menu = page.getByRole("dialog", { name: "Session actions" });
  await expect(menu).toBeVisible();
  await menu.getByText("Clear context").click();

  await expect(page.getByText(/Context cleared/).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  // Clearing memory must not close the thread — the composer stays live.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();

  // Reset is DESTRUCTIVE (the retired eve session id can never take another
  // message), so it must ask before it acts.
  await page.getByRole("button", { name: "Session actions" }).click();
  await page
    .getByRole("dialog", { name: "Session actions" })
    .getByText("Reset session")
    .click();
  await expect(page.getByText("Reset this session?")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Reset this session?")).toBeHidden();
});
