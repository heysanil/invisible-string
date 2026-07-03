/**
 * PHASE-3 browser coverage (docs/PLAN.md Phase 3 §Acceptance, item 3):
 *
 *   1. Configure a WEBHOOK trigger in the builder UI → publish (real eve build)
 *      → reveal the ingress token ONCE → fire it with a plain HTTP POST (no
 *      session, outside the browser) → the run shows up in Chat as a
 *      webhook-origin session and renders.
 *   2. A SLACK trigger binding UI smoke: the Slack trigger editor renders its
 *      routing controls and the live config nudges the user to connect a team
 *      in Settings (no Slack app is wired into the e2e stack).
 *
 * Extends the Phase-2 harness (same global-setup stack: compose + control-plane
 * + one worker + preview) — no new infra.
 */
import { expect, test } from "@playwright/test";

import { API_BASE_URL } from "../config.ts";
import { gotoSection } from "../support/authoring.ts";
import {
  openNewWorkflow,
  publishAndWaitReady,
  revealWebhookToken,
  setSlackTrigger,
  setWebhookTrigger,
  writePlainInstructions,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

test("configure a webhook trigger, reveal the token once, fire it, and see the run in chat", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "webhook");

  const workflowName = "Webhook trigger workflow";
  await openNewWorkflow(page, workflowName);
  await setWebhookTrigger(page);
  await writePlainInstructions(
    page,
    "Do exactly what the incoming webhook message asks, nothing more.",
  );
  await publishAndWaitReady(page);

  // The plaintext token is revealed exactly once, behind a "stored as a hash"
  // notice — capture it for the fire below.
  const token = await revealWebhookToken(page);
  expect(token.length).toBeGreaterThan(10);

  // Fire the webhook the way a real caller would: a plain HTTP POST with no
  // session cookie, from outside the SPA. The mock model echoes the directive.
  const fired = await page.request.post(`${API_BASE_URL}/t/${token}`, {
    data: { message: "Reply with exactly: webhook-ui-hello" },
  });
  expect(fired.status()).toBe(202);
  const body = (await fired.json()) as { accepted: boolean; runId?: string };
  expect(body.accepted).toBe(true);
  expect(body.runId).toBeTruthy();

  // The run appears in Chat as a webhook-origin session (SessionList badges
  // non-chat origins). The list isn't polled, so reload until it lands.
  await gotoSection(page, "Chat");
  const sessions = page.locator('[aria-label="Chat sessions"]');
  await expect(async () => {
    await page.reload();
    await expect(sessions.getByText("webhook", { exact: true }).first()).toBeVisible({
      timeout: 4_000,
    });
  }).toPass({ timeout: RUN_TIMEOUT_MS });

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
