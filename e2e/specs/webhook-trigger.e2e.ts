/**
 * Webhook-trigger browser coverage, agents-first:
 *
 *   1. Publish a minimal agent (real eve build) → build a WEBHOOK workflow
 *      bound to it in the three-section editor → publish (INSTANT — no
 *      build) → reveal the ingress token ONCE → fire it with a plain HTTP
 *      POST (no session, outside the browser) → the run shows up in Chat as a
 *      webhook-origin session (origin chip + workflow provenance) and renders.
 *   2. A SLACK trigger binding UI smoke: the Slack trigger editor renders its
 *      routing controls and the live config nudges the user to connect a team
 *      in Settings (no Slack app is wired into the e2e stack).
 *
 * Rides the same self-managed harness (compose + control-plane + one worker +
 * preview) — no new infra.
 */
import { expect, test } from "@playwright/test";

import { API_BASE_URL } from "../config.ts";
import { gotoSection } from "../support/authoring.ts";
import {
  openNewAgent,
  openNewWorkflow,
  publishAgentAndWaitReady,
  publishWorkflow,
  revealWebhookToken,
  selectWorkflowAgent,
  setSlackTrigger,
  setWebhookTrigger,
  writePersona,
  writePlainInstructions,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

const AGENT_NAME = "Webhook handler agent";

test("configure a webhook trigger, reveal the token once, fire it, and see the run in chat", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "webhook");

  // The delegation needs a published agent with a ready build (dispatch
  // resolves the agent's CURRENT published version at fire time).
  await openNewAgent(page, AGENT_NAME);
  await writePersona(page, "Follow the task you are given exactly, nothing more.");
  await publishAgentAndWaitReady(page);

  const workflowName = "Webhook trigger workflow";
  await openNewWorkflow(page, workflowName);
  await setWebhookTrigger(page);
  await selectWorkflowAgent(page, AGENT_NAME);
  // `@trigger.message` is typed plainly (webhook payloads have no designed
  // schema, so the autocomplete offers no fields) — dispatch resolves it
  // against the POSTed body when the task message renders.
  await writePlainInstructions(
    page,
    "Do exactly what the incoming @trigger.message asks, nothing more.",
  );
  await publishWorkflow(page);

  // The plaintext token is revealed exactly once, behind a "stored as a hash"
  // notice — capture it for the fire below.
  const token = await revealWebhookToken(page);
  expect(token.length).toBeGreaterThan(10);

  // Fire the webhook the way a real caller would: a plain HTTP POST with no
  // session cookie, from outside the SPA. The 202 answers only after dispatch
  // (a cold agent boot can take a while — be generous). The mock model echoes
  // the directive.
  const fired = await page.request.post(`${API_BASE_URL}/t/${token}`, {
    data: { message: "Reply with exactly: webhook-ui-hello" },
    timeout: RUN_TIMEOUT_MS,
  });
  expect(fired.status()).toBe(202);
  const body = (await fired.json()) as { accepted: boolean; runId?: string };
  expect(body.accepted).toBe(true);
  expect(body.runId).toBeTruthy();

  // The run appears in Chat as a webhook-origin session (SessionList badges
  // non-chat origins with the origin + workflow provenance chips). The list
  // isn't polled, so reload until it lands.
  await gotoSection(page, "Chat");
  const sessions = page.locator('[aria-label="Chat sessions"]');
  await expect(async () => {
    await page.reload();
    await expect(sessions.getByText("webhook", { exact: true }).first()).toBeVisible({
      timeout: 4_000,
    });
  }).toPass({ timeout: RUN_TIMEOUT_MS });
  // Workflow provenance rides the session row next to the origin chip.
  await expect(
    sessions.getByText(workflowName, { exact: true }).first(),
  ).toBeVisible();

  // Open the session and confirm the run rendered (working block or the reply).
  await sessions.getByText("webhook", { exact: true }).first().click();
  await expect(
    page.getByText(/webhook-ui-hello|Work(ing|ed)/).first(),
  ).toBeVisible({ timeout: RUN_TIMEOUT_MS });
});

test("slack trigger binding UI renders routing controls and a connect nudge", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "slack");

  await openNewWorkflow(page, "Slack trigger workflow");
  await setSlackTrigger(page);

  // The Slack binding editor exposes the routing rules…
  await expect(page.getByText("Only @mentions of the app")).toBeVisible();
  await expect(page.getByText("Include direct messages")).toBeVisible();
  await expect(
    page.getByPlaceholder(/leave blank for any channel/i),
  ).toBeVisible();

  // …and the live config nudges the user to connect a Slack team in Settings
  // (no Slack app is wired into the e2e stack, so no team is connectable here).
  await expect(
    page.getByText(/No Slack workspace is connected yet/i),
  ).toBeVisible();
});
