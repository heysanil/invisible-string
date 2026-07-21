/**
 * Accessibility smoke: axe-core scans of the primary surfaces — /login,
 * /agents, /agents/:id (the agent editor), /workflows/:id (the delegation
 * editor), /chat, /context, /settings — with no serious or critical
 * violations.
 *
 * color-contrast is disabled: axe computes contrast against the nearest opaque
 * DOM background, which cannot see through the E1 `backdrop-filter` glass
 * (the composited result differs), so it reports false positives on this
 * design. Every other WCAG 2 A/AA rule is enforced.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { openNewAgent, openNewWorkflow } from "../support/builder.ts";
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

  // Authenticate + seed a workspace.
  await signUpIntoWorkspace(page, "a11y");

  // ── /agents (card grid) ────────────────────────────────────────────────────
  await gotoSection(page, "Agents");
  await expect(
    page.getByRole("heading", { name: "Agents", level: 1 }),
  ).toBeVisible();
  await scan(page, "/agents");

  // ── /agents/:id (the agent editor) ─────────────────────────────────────────
  await openNewAgent(page, "A11y agent");
  await expect(
    page.getByRole("navigation", { name: "Agent sections" }),
  ).toBeVisible();
  await scan(page, "/agents/:id");

  // ── /workflows/:id (the three-section delegation editor) ───────────────────
  await openNewWorkflow(page, "A11y workflow");
  await expect(page.getByRole("heading", { name: "Trigger", level: 2 })).toBeVisible();
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
