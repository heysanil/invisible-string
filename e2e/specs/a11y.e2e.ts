/**
 * Accessibility smoke: axe-core scans of the primary surfaces — /login,
 * /chat, /workflows/:id, /context, /settings — with no serious or critical
 * violations.
 *
 * color-contrast is disabled: axe computes contrast against the nearest opaque
 * DOM background, which cannot see through the E1 `backdrop-filter` glass
 * (the composited result differs), so it reports false positives on this
 * design. Every other WCAG 2 A/AA rule is enforced.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { openNewWorkflow } from "../support/builder.ts";
import { gotoSection } from "../support/authoring.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .disableRules(["color-contrast"])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious,
    `${label}: ${serious.map((v) => `${v.id} (${v.nodes.length})`).join(", ")}`,
  ).toEqual([]);
}

test("no serious or critical a11y violations on the primary surfaces", async ({
  page,
}) => {
  // ── /login (unauthenticated) ───────────────────────────────────────────────
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
  await scan(page, "/login");

  // Authenticate + seed a workspace, then build a workflow to scan the builder.
  await signUpIntoWorkspace(page, "a11y");
  const workflowName = "A11y workflow";
  await openNewWorkflow(page, workflowName);
  await expect(
    page.getByRole("navigation", { name: "Workflow pillars" }),
  ).toBeVisible();
  await scan(page, "/workflows/:id");

  // ── /chat ──────────────────────────────────────────────────────────────────
  await gotoSection(page, "Chat");
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
  await scan(page, "/chat");

  // ── /context ───────────────────────────────────────────────────────────────
  await gotoSection(page, "Context");
  await expect(
    page.getByRole("heading", { name: "Context", level: 1 }),
  ).toBeVisible();
  await scan(page, "/context");

  // ── /settings ──────────────────────────────────────────────────────────────
  await gotoSection(page, "Settings");
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  await scan(page, "/settings");
});
