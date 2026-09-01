/**
 * Webhook-trigger browser coverage, pipeline-first:
 *
 *   1. Build a WEBHOOK pipeline through the DIRECT-manipulation lane (no
 *      copilot, no agent, no eve build): webhook trigger + one TOOL step on
 *      a custom stub-MCP connection, configured through the inspector's real
 *      connection select → cached-tool picker → schema-aware arg field with
 *      an embedded `@trigger.message` template → publish (INSTANT — no
 *      build) → reveal the ingress token ONCE → fire it with a plain HTTP
 *      POST (no session, outside the browser) → the run lands in the Runs
 *      tab with its step timeline, and the stub MCP server received the note
 *      with the @trigger ref RESOLVED against the POSTed body.
 *   2. A SLACK trigger binding UI smoke: the Slack trigger editor (inside
 *      the expanded TriggerCard) renders its routing controls and the live
 *      config nudges the user to connect a team in Settings (no Slack app is
 *      wired into the e2e stack).
 *
 * Rides the same self-managed harness (compose + control-plane + one worker +
 * preview) — no new infra.
 */
import { expect, test } from "@playwright/test";

import { API_BASE_URL, REGISTRY_STUB_BASE_URL } from "../config.ts";
import {
  addCustomConnection,
  waitForConnectionHealthy,
} from "../support/authoring.ts";
import {
  addFirstStep,
  configureToolStep,
  openNewWorkflow,
  openRunsTab,
  publishWorkflow,
  revealWebhookToken,
  setSlackTrigger,
  setWebhookTrigger,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

const CONNECTION = "notes";
/** The stub's single MCP tool (e2e/scripts/stub-mcp.ts). */
const STUB_TOOL = "save_note";
const WEBHOOK_MESSAGE = "webhook-ui-hello";

test("configure a webhook tool pipeline, reveal the token once, fire it, and watch the timeline", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "webhook");

  // The tool step calls the stub server through a workspace connection whose
  // probe must have cached `tools/list` (the inspector's tool picker and the
  // publish-time checks read that cache).
  await addCustomConnection(page, { name: CONNECTION });
  await waitForConnectionHealthy(page, CONNECTION);

  const workflowName = "Webhook trigger workflow";
  await openNewWorkflow(page, workflowName);
  await setWebhookTrigger(page);

  // One deterministic tool step. `@trigger.message` is typed inline in the
  // arg field (webhook payloads have no designed schema — the codec turns
  // the embedded ref into a `$tpl` template) and dispatch resolves it
  // against the POSTed body.
  await addFirstStep(page, "Tool call");
  await configureToolStep(page, {
    connectionName: CONNECTION,
    tool: STUB_TOOL,
    arg: { name: "note", text: "Webhook says: @trigger.message" },
  });
  await publishWorkflow(page);

  // The plaintext token is revealed exactly once, behind a "stored as a hash"
  // notice — capture it for the fire below.
  const token = await revealWebhookToken(page);
  expect(token.length).toBeGreaterThan(10);

  // Fire the webhook the way a real caller would: a plain HTTP POST with no
  // session cookie, from outside the SPA. The 202 answers once the pipeline
  // run is accepted; execution is the in-process driver (no agent boot).
  const fired = await page.request.post(`${API_BASE_URL}/t/${token}`, {
    data: { message: WEBHOOK_MESSAGE },
    timeout: RUN_TIMEOUT_MS,
  });
  expect(fired.status()).toBe(202);
  const body = (await fired.json()) as { accepted: boolean; runId?: string };
  expect(body.accepted).toBe(true);
  expect(body.runId).toBeTruthy();

  // The run lands in the Runs tab with its step timeline: the tool step
  // reads Done and the run settles succeeded.
  await openRunsTab(page);
  await page.getByTestId("run-row").first().click();
  await expect(page.getByText("succeeded").first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Outside the browser: the stub MCP server received the RENDERED call —
  // the @trigger.message template resolved against the POSTed body.
  const calls = (await (
    await page.request.get(`${REGISTRY_STUB_BASE_URL}/__calls`)
  ).json()) as { calls: { name: string; args: { note?: string } }[] };
  const note = calls.calls.find(
    (call) =>
      call.name === STUB_TOOL &&
      (call.args.note ?? "").includes(WEBHOOK_MESSAGE),
  );
  expect(note, "stub MCP never received the rendered save_note call").toBeTruthy();
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
