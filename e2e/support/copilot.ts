/**
 * Copilot driving helpers shared by the copilot acceptance spec and the
 * screenshot-capture spec, across the two surfaces:
 *
 * - the AGENT editor keeps the docked rail (`Open Copilot` pill →
 *   `role="complementary"` dock) — `openCopilotAndSend`;
 * - the WORKFLOW editor's copilot is an always-open primary pane (no pill,
 *   no collapse) with the allow-edits switch in its header —
 *   `sendWorkflowCopilotMessage` + `setAutoApply`.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Open the docked copilot rail (agent editor) and send `message` through its
 * composer. The dock's socket connects lazily on open and drops frames sent
 * before the handshake completes, so the click is retried until the user
 * bubble renders — retries are safe no-ops after a successful send (the
 * composer clears and the send button disables).
 */
export async function openCopilotAndSend(
  page: Page,
  message: string,
): Promise<void> {
  await page.getByRole("button", { name: "Open Copilot" }).click();
  const dock = page.getByRole("complementary", { name: "Copilot" });
  await expect(dock).toBeVisible();
  await sendCopilotMessage(page, dock, message);
}

/**
 * Send `message` through the workflow editor's always-open copilot pane. The
 * pane's socket is live from mount (`enabled: true`), but the same
 * retry-until-the-bubble-renders guard covers a still-connecting socket.
 */
export async function sendWorkflowCopilotMessage(
  page: Page,
  message: string,
): Promise<void> {
  const pane = workflowCopilotPane(page);
  await expect(pane).toBeVisible();
  await sendCopilotMessage(page, pane, message);
}

/** The workflow editor's copilot pane (left, primary). */
export function workflowCopilotPane(page: Page): Locator {
  return page.locator('section[aria-label="Copilot"]');
}

async function sendCopilotMessage(
  page: Page,
  surface: Locator,
  message: string,
): Promise<void> {
  await surface.getByRole("textbox", { name: "Ask copilot" }).fill(message);
  // The accessible name carries the mode ("Send to copilot (auto-apply on)")
  // — match the prefix so both modes send.
  const sendButton = surface.getByRole("button", { name: /^Send to copilot/ });
  // Scoped to the thread log: the composer still holds the text until the
  // send actually lands, so a page-wide text match would false-positive.
  const userBubble = surface
    .getByRole("log", { name: "Copilot conversation" })
    .getByText(message, { exact: true });
  await expect(async () => {
    await sendButton.click();
    await expect(userBubble).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Flip the workflow pane's allow-edits switch to `on`. The INITIAL value is
 * surface-aware (ON for never-published drafts, OFF once published), so specs
 * that want the Apply/Dismiss accept gate must switch auto-apply OFF first.
 */
export async function setAutoApply(page: Page, on: boolean): Promise<void> {
  const toggle = page.getByRole("switch", { name: "Auto-apply edits" });
  await expect(toggle).toBeVisible();
  const state = await toggle.getAttribute("aria-checked");
  if (state !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
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
