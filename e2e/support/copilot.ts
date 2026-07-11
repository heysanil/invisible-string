/**
 * Copilot-dock driving helpers shared by the copilot acceptance spec and the
 * screenshot-capture spec, plus section locators for asserting where applied
 * suggestions land (the workflow editor flashes the target SECTION; the agent
 * editor flashes its rail card).
 */
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Open the docked copilot rail and send `message` through its composer.
 * The dock's socket connects lazily on open and drops frames sent before the
 * handshake completes, so the click is retried until the user bubble renders —
 * retries are safe no-ops after a successful send (the composer clears and
 * the send button disables).
 */
export async function openCopilotAndSend(
  page: Page,
  message: string,
): Promise<void> {
  await page.getByRole("button", { name: "Open Copilot" }).click();
  const dock = page.getByRole("complementary", { name: "Copilot" });
  await expect(dock).toBeVisible();
  await dock.getByRole("textbox", { name: "Ask copilot" }).fill(message);
  const sendButton = dock.getByRole("button", { name: "Send to copilot" });
  const userBubble = dock.getByText(message, { exact: true });
  await expect(async () => {
    await sendButton.click();
    await expect(userBubble).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/** A workflow-editor section (`<section>` labelled by its heading). */
export function workflowSection(
  page: Page,
  section: "trigger" | "agent" | "instructions",
): Locator {
  return page.locator(`section[aria-labelledby="workflow-section-${section}"]`);
}

/**
 * Assert the flash treatment an applied copilot suggestion paints on its
 * workflow section (replaces the old pillar-rail live-summary assertions —
 * the section itself is the live surface now). The flash is ~900 ms, so this
 * must run right after Apply.
 */
export async function expectWorkflowSectionFlash(
  page: Page,
  section: "trigger" | "agent" | "instructions",
): Promise<void> {
  await expect(
    page.locator(
      `section.pillar-flash[aria-labelledby="workflow-section-${section}"]`,
    ),
  ).toBeVisible({ timeout: 2_000 });
}

/** The agent editor's rail card (live summary) for a section. */
export function agentRailCard(
  page: Page,
  section: "Persona" | "Model" | "Context" | "Access",
): Locator {
  return page
    .getByRole("navigation", { name: "Agent sections" })
    .getByRole("button", { name: new RegExp(`^${section}`) });
}
