/**
 * Agent-editor + workflow-editor + chat driving helpers (agents-first).
 *
 * The AGENT is the compile unit now: `openNewAgent` → equip (persona, model,
 * context) → `publishAgentAndWaitReady` (real eve build). Workflows are a
 * standing delegation (trigger → agent → instructions) edited in a single
 * three-section column and published INSTANTLY (`publishWorkflow` — validate
 * + snapshot, no build). Chat targets agents: `startChatAndSend` drives the
 * "New chat" agent picker.
 */
import { expect, type Page } from "@playwright/test";

import { gotoSection } from "./authoring.ts";

/** A fresh eve build can take many minutes on a cold machine — be generous. */
export const BUILD_TIMEOUT_MS = 20 * 60_000;
/** First run boots the agent from its tarball (cold) — generous too. */
export const RUN_TIMEOUT_MS = 8 * 60_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent editor (/agents/:id)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fresh agent from /agents and open its editor; renames the
 * "Untitled agent" draft to `name` through the header's inline input.
 */
export async function openNewAgent(page: Page, name: string): Promise<void> {
  await gotoSection(page, "Agents");
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New agent" }).first().click();
  await page.waitForURL(/\/agents\/[^/]+$/);
  await expect(
    page.getByRole("navigation", { name: "Agent sections" }),
  ).toBeVisible();

  const nameInput = page.getByRole("textbox", { name: "Agent name" });
  await nameInput.fill(name);
  await nameInput.press("Enter");
}

/** Type the agent's persona document into the CodeMirror markdown editor. */
export async function writePersona(page: Page, text: string): Promise<void> {
  const editor = page.getByRole("textbox", { name: "Persona" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(text);
  await expect(editor).toContainText(text.slice(0, 12));
}

/**
 * Append text at the very end of the persona editor (caret moved to the
 * document end first, so it never depends on where a previous edit left it).
 */
export async function appendPersona(page: Page, text: string): Promise<void> {
  const editor = page.getByRole("textbox", { name: "Persona" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type(text);
}

/** Pick a model preset in the agent editor's MODEL section. */
export async function setAgentModelPreset(
  page: Page,
  preset: "Powerful" | "Balanced" | "Quick",
): Promise<void> {
  await page
    .getByRole("radiogroup", { name: "Model preset" })
    .getByRole("radio", { name: preset })
    .click();
}

/**
 * Attach an existing connection or skill in the agent editor's CONTEXT
 * section via its Browse picker (an anchored popover dialog).
 */
export async function attachAgentResource(
  page: Page,
  kind: "connection" | "skill",
  name: string,
): Promise<void> {
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

/** Set an attached connection's approval policy via its settings popover. */
export async function setAgentConnectionApproval(
  page: Page,
  connectionName: string,
  policyLabel: "Always ask" | "Once per session" | "Never — auto-allow",
): Promise<void> {
  await page.getByRole("button", { name: `${connectionName} settings` }).click();
  const popover = page.getByRole("dialog", { name: `${connectionName} settings` });
  await popover.getByLabel("Approval policy").selectOption({ label: policyLabel });
  // Dismiss the popover so it doesn't overlap later clicks.
  await page.keyboard.press("Escape");
}

/**
 * Publish the agent from the rail and wait for the READY state (or fail fast
 * on a build error). This is the REAL `eve build` — the one long wait in the
 * suite.
 */
export async function publishAgentAndWaitReady(page: Page): Promise<void> {
  const publishButton = page.getByRole("button", { name: "Publish", exact: true });
  await expect(publishButton).toBeEnabled();
  await publishButton.click();

  const outcome = await waitForAgentPublishOutcome(page);
  if (outcome === "error") {
    throw new Error("agent publish failed — see the rail error box in the trace");
  }
  // Rail chip: "Published and built." / "Published — build served from
  // cache."; the success toast rephrases the cache case — hence the loose
  // pattern + .first().
  await expect(
    page.getByText(/Published and built\.|served from (build )?cache/).first(),
  ).toBeVisible();
}

async function waitForAgentPublishOutcome(page: Page): Promise<"ready" | "error"> {
  const ready = page
    .getByText(/Published and built\.|served from (build )?cache/)
    .first();
  const failed = page.getByText("Publish failed").first();
  return Promise.race([
    ready.waitFor({ state: "visible", timeout: BUILD_TIMEOUT_MS }).then(() => "ready" as const),
    failed.waitFor({ state: "visible", timeout: BUILD_TIMEOUT_MS }).then(() => "error" as const),
  ]);
}

/**
 * Wait (on /agents) until the named agent's card shows the green "Published"
 * lifecycle chip — i.e. its published version's build SUCCEEDED. Used for the
 * seeded "General Purpose" agent, which every new workspace auto-publishes in
 * the background.
 */
export async function waitForAgentPublished(
  page: Page,
  agentName: string,
): Promise<void> {
  await gotoSection(page, "Agents");
  const card = page.getByRole("link", {
    name: new RegExp(`^${escapeRegExp(agentName)}\\b`),
  });
  await expect(async () => {
    await page.reload();
    await expect(card).toBeVisible({ timeout: 4_000 });
    await expect(card.getByText("Published", { exact: true })).toBeVisible({
      timeout: 4_000,
    });
  }).toPass({ timeout: BUILD_TIMEOUT_MS });
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow editor (/workflows/:id) — trigger → agent → instructions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fresh workflow and open the editor; sets a distinctive name. The
 * editor is a single column with all three sections always expanded — no
 * rail, no pillar switching.
 */
export async function openNewWorkflow(page: Page, name: string): Promise<void> {
  await gotoSection(page, "Workflows");
  await page.getByRole("button", { name: "New workflow" }).first().click();
  await page.waitForURL(/\/workflows\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "Trigger", level: 2 })).toBeVisible();

  const nameInput = page.getByRole("textbox", { name: "Workflow name" });
  await nameInput.fill(name);
  await nameInput.press("Enter");
}

/** Configure a form trigger with exactly two fields. */
export async function setFormTriggerWithTwoFields(
  page: Page,
  fields: [{ key: string; label: string }, { key: string; label: string }],
): Promise<void> {
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

/** Select the Webhook trigger type in the Trigger section. */
export async function setWebhookTrigger(page: Page): Promise<void> {
  await page
    .getByRole("radiogroup", { name: "Trigger type" })
    .getByRole("radio", { name: "Webhook" })
    .click();
}

/** Select the Slack trigger type in the Trigger section. */
export async function setSlackTrigger(page: Page): Promise<void> {
  await page
    .getByRole("radiogroup", { name: "Trigger type" })
    .getByRole("radio", { name: "Slack" })
    .click();
}

/**
 * Pick the agent who does the work — the AGENT section's card radio-group of
 * published agents.
 */
export async function selectWorkflowAgent(
  page: Page,
  agentName: string,
): Promise<void> {
  const radio = page
    .getByRole("radiogroup", { name: "Agent" })
    .getByRole("radio", { name: new RegExp(`^${escapeRegExp(agentName)}\\b`) });
  await radio.click();
  await expect(radio).toHaveAttribute("aria-checked", "true");
}

/**
 * Reveal the ingress token ONCE via the live webhook config (rendered inside
 * the Trigger section for webhook/form drafts) and return the plaintext.
 * Asserts the shown-once hash notice.
 */
export async function revealWebhookToken(page: Page): Promise<string> {
  await page.getByRole("button", { name: /Generate token|Rotate token/ }).click();
  // The plaintext is shown once with a "we store only a hash" notice.
  await expect(page.getByText(/store only a hash, so it/i)).toBeVisible();
  const tokenCode = page.getByTestId("revealed-token");
  await expect(tokenCode).toBeVisible();
  const token = (await tokenCode.textContent())?.trim();
  if (!token) throw new Error("revealed webhook token was empty");
  return token;
}

/**
 * Write instructions in the CodeMirror editor and exercise the real `@`
 * autocomplete: type `@trigger.` → assert the popup → pick a field.
 */
export async function writeInstructionsWithTriggerRef(
  page: Page,
  opts: { lead: string; triggerField: string },
): Promise<void> {
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
  const editor = page.getByRole("textbox", { name: "Instructions editor" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(text);
  await expect(editor).toContainText(text.slice(0, 12));
}

/**
 * Publish the workflow — INSTANT (server-side validate + snapshot, no build).
 * Resolves once the success toast confirms the snapshot is live.
 */
export async function publishWorkflow(page: Page): Promise<void> {
  const publishButton = page.getByRole("button", { name: "Publish", exact: true });
  await expect(publishButton).toBeEnabled();
  await publishButton.click();
  await expect(
    page.getByText("Published — live for new runs.").first(),
  ).toBeVisible();
}

/**
 * Fire a published workflow through the header's Run popover (the REAL
 * trigger-dispatch path: `POST …/workflows/:id/run`). `values` fills the
 * popover body — form fields by label, or the message textarea for
 * manual/slack triggers. Resolves once the popover confirms the run started.
 */
export async function runWorkflowFromHeader(
  page: Page,
  opts: { formValues?: Record<string, string>; message?: string } = {},
): Promise<void> {
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Run this workflow" });
  await expect(popover).toBeVisible();

  for (const [label, value] of Object.entries(opts.formValues ?? {})) {
    await popover.getByLabel(label).fill(value);
  }
  if (opts.message !== undefined) {
    await popover.getByLabel("Message").fill(opts.message);
  }

  await popover.getByRole("button", { name: /Start run|Fire now/ }).click();
  // The POST resolves only after the full dispatch (ensure-agent → eve
  // session) — a cold agent boot can take a while, so wait generously.
  await expect(popover.getByTestId("run-started")).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat (agent picker)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a new chat with a PUBLISHED agent and send the first message:
 * "New chat" → the agent picker modal (published agents only) → pick by
 * name → the new-chat composer → send.
 */
export async function startChatAndSend(
  page: Page,
  agentName: string,
  message: string,
): Promise<void> {
  await gotoSection(page, "Chat");
  await page.getByRole("button", { name: "New chat" }).click();
  const picker = page.getByRole("dialog", { name: "Start a new chat" });
  await picker
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(agentName)}\\b`) })
    .click();

  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible();
  await composer.fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
}
