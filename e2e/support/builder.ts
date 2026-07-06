/**
 * Builder + chat driving helpers: create a workflow, configure each pillar,
 * publish (real eve build), then start a chat session against it.
 */
import { expect, type Page } from "@playwright/test";

import { gotoSection } from "./authoring.ts";

/** A fresh eve build can take many minutes on a cold machine — be generous. */
export const BUILD_TIMEOUT_MS = 20 * 60_000;
/** First run boots the agent from its tarball (cold) — generous too. */
export const RUN_TIMEOUT_MS = 8 * 60_000;

type PillarLabel = "Trigger" | "Context" | "Agent" | "Instructions";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Create a fresh workflow and open the builder; sets a distinctive name. */
export async function openNewWorkflow(page: Page, name: string): Promise<void> {
  await gotoSection(page, "Workflows");
  await page.getByRole("button", { name: "New workflow" }).first().click();
  await page.waitForURL(/\/workflows\/[^/]+$/);
  await expect(
    page.getByRole("navigation", { name: "Workflow pillars" }),
  ).toBeVisible();

  const nameInput = page.getByRole("textbox", { name: "Workflow name" });
  await nameInput.fill(name);
  await nameInput.press("Enter");
}

/** Focus a pillar via its rail card and confirm the editor pane switched. */
export async function focusPillar(page: Page, pillar: PillarLabel): Promise<void> {
  await page
    .getByRole("navigation", { name: "Workflow pillars" })
    .getByRole("button", { name: new RegExp(`^${pillar}`) })
    .click();
  await expect(
    page.getByRole("heading", { name: pillar, level: 2 }),
  ).toBeVisible();
}

/** Configure a form trigger with exactly two fields. */
export async function setFormTriggerWithTwoFields(
  page: Page,
  fields: [{ key: string; label: string }, { key: string; label: string }],
): Promise<void> {
  await focusPillar(page, "Trigger");
  await page
    .getByRole("radiogroup", { name: "Trigger type" })
    .getByRole("radio", { name: "Form" })
    .click();

  // Selecting "Form" seeds one field; add a second.
  await page.getByRole("button", { name: "Add field" }).click();

  const labels = page.getByPlaceholder("Label (e.g. Customer email)");
  const keys = page.getByPlaceholder("key");
  await expect(keys).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await labels.nth(i).fill(fields[i]!.label);
    await keys.nth(i).fill(fields[i]!.key);
  }
}

/** Select the Webhook trigger type in the Trigger pillar. */
export async function setWebhookTrigger(page: Page): Promise<void> {
  await focusPillar(page, "Trigger");
  await page
    .getByRole("radiogroup", { name: "Trigger type" })
    .getByRole("radio", { name: "Webhook" })
    .click();
}

/** Select the Slack trigger type in the Trigger pillar. */
export async function setSlackTrigger(page: Page): Promise<void> {
  await focusPillar(page, "Trigger");
  await page
    .getByRole("radiogroup", { name: "Trigger type" })
    .getByRole("radio", { name: "Slack" })
    .click();
}

/**
 * Reveal the ingress token ONCE via the live webhook config and return the
 * plaintext. Asserts the shown-once hash notice. The workflow must already be
 * a saved webhook/form draft (mint reads the draft trigger type).
 */
export async function revealWebhookToken(page: Page): Promise<string> {
  await focusPillar(page, "Trigger");
  await page.getByRole("button", { name: /Generate token|Rotate token/ }).click();
  // The plaintext is shown once with a "we store only a hash" notice.
  await expect(
    page.getByText(/store only a hash, so it/i),
  ).toBeVisible();
  const tokenCode = page.getByTestId("revealed-token");
  await expect(tokenCode).toBeVisible();
  const token = (await tokenCode.textContent())?.trim();
  if (!token) throw new Error("revealed webhook token was empty");
  return token;
}

/** Attach an existing connection or skill via the pillar's Browse picker. */
export async function attachResource(
  page: Page,
  kind: "connection" | "skill",
  name: string,
): Promise<void> {
  await focusPillar(page, "Context");
  const heading = kind === "connection" ? "Connections" : "Skills";
  const dialogName = kind === "connection" ? "Add a connection" : "Add a skill";
  const searchName = kind === "connection" ? "Search connections" : "Search skills";

  // The "Browse" trigger sits in the same header row as its column heading;
  // scope to that row so the connections/skills triggers never collide.
  const headerRow = page
    .getByRole("heading", { name: heading, exact: true })
    .locator("xpath=..");
  await headerRow.getByRole("button", { name: "Browse" }).click();

  const picker = page.getByRole("dialog", { name: dialogName });
  await picker.getByRole("textbox", { name: searchName }).fill(name);
  // Anchor at the start so "notes" does not also match "Registry notes".
  await picker
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(name)}\\b`) })
    .click();

  // The attached row shows the resource name with a Remove control.
  await expect(
    page.getByRole("button", { name: `Remove ${name}` }),
  ).toBeVisible();
}

/** Set an attached connection's approval policy via its inline settings popover. */
export async function setConnectionApproval(
  page: Page,
  connectionName: string,
  policyLabel: "Always ask" | "Once per session" | "Never — auto-allow",
): Promise<void> {
  await focusPillar(page, "Context");
  await page.getByRole("button", { name: `${connectionName} settings` }).click();
  const popover = page.getByRole("dialog", { name: `${connectionName} settings` });
  await popover.getByLabel("Approval policy").selectOption({ label: policyLabel });
  // Dismiss the popover so it doesn't overlap later clicks.
  await page.keyboard.press("Escape");
}

/**
 * Write instructions in the CodeMirror editor and exercise the real `@`
 * autocomplete: type `@trigger.` → assert the popup → pick a field.
 */
export async function writeInstructionsWithTriggerRef(
  page: Page,
  opts: { lead: string; triggerField: string },
): Promise<void> {
  await focusPillar(page, "Instructions");
  const editor = page.getByRole("textbox", { name: "Instructions editor" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(opts.lead);
  await page.keyboard.type("@trigger.");

  // The CodeMirror autocomplete popup must appear with the field option.
  const option = page.getByRole("option", {
    name: new RegExp(`@trigger\\.${opts.triggerField}`),
  });
  await expect(option).toBeVisible();
  await option.click();

  await expect(editor).toContainText(`@trigger.${opts.triggerField}`);
}

/**
 * Append text at the very end of the instructions editor. The caret is first
 * moved to the document end (select-all → ArrowRight collapses the selection to
 * its right edge) so this never depends on where the previous edit left it, and
 * the caller's text can safely lead with a space + blank line to break out of
 * any `@ref` token before the newline (an open autocomplete would swallow it).
 */
export async function appendInstructions(page: Page, text: string): Promise<void> {
  await focusPillar(page, "Instructions");
  const editor = page.getByRole("textbox", { name: "Instructions editor" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  // Nothing open to eat the newlines we are about to type.
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await page.keyboard.type(text);
}

/** Write plain instructions (no references) — enough to satisfy publish. */
export async function writePlainInstructions(page: Page, text: string): Promise<void> {
  await focusPillar(page, "Instructions");
  const editor = page.getByRole("textbox", { name: "Instructions editor" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(text);
  await expect(editor).toContainText(text.slice(0, 12));
}

/** Click Publish and wait for the ready chip (or fail fast on a build error). */
export async function publishAndWaitReady(page: Page): Promise<void> {
  await focusPillar(page, "Trigger"); // any pillar; ensures the rail is present
  const publishButton = page.getByRole("button", { name: "Publish", exact: true });
  await expect(publishButton).toBeEnabled();
  await publishButton.click();

  const outcome = await waitForPublishOutcome(page);
  if (outcome === "error") {
    throw new Error("publish failed — see the rail error box in the trace");
  }
  // The ready copy also appears in a success toast, hence .first().
  await expect(
    page.getByText(/Published and built\.|build served from cache/).first(),
  ).toBeVisible();
}

async function waitForPublishOutcome(page: Page): Promise<"ready" | "error"> {
  // Both the rail chip and a toast carry the copy — .first() keeps the locator
  // single so waitFor doesn't trip strict mode.
  const ready = page
    .getByText(/Published and built\.|build served from cache/)
    .first();
  const failed = page.getByText("Publish failed").first();
  const result = await Promise.race([
    ready.waitFor({ state: "visible", timeout: BUILD_TIMEOUT_MS }).then(() => "ready" as const),
    failed.waitFor({ state: "visible", timeout: BUILD_TIMEOUT_MS }).then(() => "error" as const),
  ]);
  return result;
}

/** Start a new chat session for the (published) workflow and send a message. */
export async function startChatAndSend(
  page: Page,
  workflowName: string,
  message: string,
): Promise<void> {
  await gotoSection(page, "Chat");
  await page.getByRole("button", { name: "New chat" }).click();
  const picker = page.getByRole("dialog", { name: "Start a new chat" });
  await picker.getByRole("button", { name: new RegExp(workflowName) }).click();

  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible();
  await composer.fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
}
