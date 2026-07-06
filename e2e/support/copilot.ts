/**
 * Copilot-dock driving helpers shared by the copilot acceptance spec and the
 * screenshot-capture spec.
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

/** The pillar rail card (live summary) for a pillar. */
export function railCard(
  page: Page,
  pillar: "Trigger" | "Context" | "Agent" | "Instructions",
): Locator {
  return page
    .getByRole("navigation", { name: "Workflow pillars" })
    .getByRole("button", { name: new RegExp(`^${pillar}`) });
}
