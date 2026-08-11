/**
 * Connection health + tool-picker journey (connectors redesign spec §7/§10,
 * plan-2 Task 7) against the real stack:
 *
 *   1. CUSTOM-install the stub MCP server (`/mcp`). The control plane's
 *      after-create probe is fire-and-forget and rides the guarded egress
 *      fetch — the stub is plain http on 127.0.0.1, so the harness boots the
 *      control plane with MCP_PROBE_ALLOW_PRIVATE=1 (see config.ts). The
 *      card's green health dot + discovered tool count are asserted through a
 *      reload poll (the probe persists server-side after the create response;
 *      the SPA has no push channel for it).
 *   2. Open the connection DETAIL: the health panel shows Healthy with a
 *      recent last-checked timestamp. (No auto re-probe fires — the
 *      after-create check is fresh, well inside the 15-minute staleness
 *      window.)
 *   3. The TOOL PICKER lists the discovered `save_note` as a checkbox;
 *      allow-listing it PATCHes `toolAllow: ["save_note"]` and the card
 *      summarizes "1 allowed".
 *   4. TEST CONNECTION re-probes on demand: the probe POST returns the fresh
 *      DTO with health "ok" (an unhealthy result would still be a 200 — the
 *      health value is the assertion).
 *   5. The connection ATTACHES to an agent — the existing context flow is
 *      still green on a probed, allow-listed connection.
 *
 * The full attach → publish → chat spine is add-connection.e2e.ts's job; this
 * spec stops at the attach so the suite pays for one fewer eve build.
 */
import { expect, test } from "@playwright/test";

import { addCustomConnection } from "../support/authoring.ts";
import { attachAgentResource, openNewAgent } from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

const CONNECTION = "health-notes";
const AGENT_NAME = "Health journey agent";
/** The stub's single MCP tool (e2e/scripts/stub-mcp.ts). */
const STUB_TOOL = "save_note";

test("a custom connection is probed healthy, its tools drive the picker, and test-connection re-probes", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "health");

  // ── 1. custom-URL install against the stub /mcp ────────────────────────────
  await addCustomConnection(page, { name: CONNECTION });

  // The after-create probe lands out-of-band: poll via reload until the card
  // carries the green dot (dot-only badge titled "Healthy") + the tool count.
  const card = page.getByRole("button", { name: `${CONNECTION} details` });
  await expect(async () => {
    await page.reload();
    await expect(card).toBeVisible({ timeout: 4_000 });
    await expect(card.getByTitle("Healthy")).toBeVisible({ timeout: 4_000 });
    await expect(card.getByText("1 tool", { exact: true })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 60_000 });

  // ── 2. detail: health panel shows ok with a recent check ───────────────────
  await card.click();
  const detail = page.getByRole("dialog", { name: CONNECTION });
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Healthy", { exact: true })).toBeVisible();
  await expect(detail.getByText(/^Checked (just now|\dm ago)$/)).toBeVisible();

  // ── 3. tool picker: the discovered tool is a checkbox; allow-list it ───────
  await detail.getByRole("button", { name: /^allow$/i }).click();
  const toolCheckbox = detail.getByRole("checkbox", { name: STUB_TOOL });
  await expect(toolCheckbox).toBeVisible();
  // The mode click itself PATCHes a null filter — key the wait on the body
  // that actually carries the allow-listed name.
  const allowPatched = page.waitForResponse(
    (res) =>
      res.request().method() === "PATCH" &&
      res.url().includes("/connections/") &&
      (res.request().postData()?.includes(`"${STUB_TOOL}"`) ?? false),
  );
  await toolCheckbox.click();
  const patchResponse = await allowPatched;
  expect(patchResponse.ok()).toBe(true);
  await expect(toolCheckbox).toBeChecked();

  // ── 4. Test connection: on-demand re-probe through the probe route ─────────
  const probed = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" && res.url().includes("/probe"),
  );
  await detail.getByRole("button", { name: "Test connection" }).click();
  const probeResponse = await probed;
  expect(probeResponse.status()).toBe(200);
  const probeBody = (await probeResponse.json()) as {
    connection: { health: string };
  };
  expect(probeBody.connection.health).toBe("ok");
  await expect(detail.getByText("Healthy", { exact: true })).toBeVisible();

  // Close the drawer (the header's Close button — keyboard Escape rides the
  // panel's own key handler, and focus can sit on body after the probe
  // button's loading cycle); the card now summarizes the persisted allow-list.
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(detail).toBeHidden();
  await expect(card.getByText("1 allowed", { exact: true })).toBeVisible();

  // ── 5. attach to an agent — the existing flow still green ──────────────────
  await openNewAgent(page, AGENT_NAME);
  await attachAgentResource(page, "connection", CONNECTION);
});
