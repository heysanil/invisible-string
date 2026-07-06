/**
 * PRODUCT SCREENSHOT CAPTURE — env-gated; never runs in the normal E2E suite.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * Everything in this file is skipped unless SCREENSHOTS=1. The gate lives
 * HERE (a file-scope `test.skip`) rather than in playwright.config.ts, so
 * `playwright test --list` still shows the spec and the CI e2e job (which
 * sets no SCREENSHOTS) lists it, then skips it — the spec can never silently
 * fall out of the suite via a testMatch change.
 *
 * Regenerate every PNG in docs/screenshots/ with:
 *
 *   cd e2e && SCREENSHOTS=1 bunx playwright test screenshots --project=acceptance
 *
 * ── How it works ────────────────────────────────────────────────────────────
 * Rides the exact acceptance harness (compose p2e2e → stub MCP →
 * control-plane → worker → vite preview, eve mock model, scripted copilot
 * fake — see global-setup.ts): one signup + workspace, the data is built
 * once, then the routes are walked in an order that needs only a single
 * publish (real eve build). Every shot first asserts the state it
 * photographs — the same assertions the acceptance specs use — because a
 * blank pane is a failure, not a deliverable. Captures are full-window at
 * 1600×1000, deviceScaleFactor 2 (crisp retina), with animations
 * force-completed and the caret hidden at shot time.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import {
  addCustomConnection,
  createSkillWithAttachment,
  gotoSection,
  installRegistryConnection,
} from "../support/authoring.ts";
import {
  appendInstructions,
  attachResource,
  openNewWorkflow,
  publishAndWaitReady,
  setFormTriggerWithTwoFields,
  startChatAndSend,
  writeInstructionsWithTriggerRef,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import {
  SCAFFOLD_CONNECTION_NAME,
  SCAFFOLD_PROMPT,
} from "../support/copilot-script.ts";
import { openCopilotAndSend, railCard } from "../support/copilot.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

/** docs/screenshots/, resolved from this spec (e2e/specs → repo root). */
const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/screenshots",
);

// The gate: present in every listing, executed only when explicitly asked.
test.skip(
  process.env.SCREENSHOTS !== "1",
  "screenshot capture is env-gated — run with SCREENSHOTS=1",
);

test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

const WORKFLOW_NAME = "Support triage workflow";
const REGISTRY_CONNECTION = "Registry notes";
const SKILL_NAME = "Brand voice";

// The chat shot photographs a real published run replying in clean prose — a
// support-triage draft, not a tool-JSON dump. The message reads naturally (no
// built-in tool name, so eve's mock never fires the working block); the reply
// text is authored as a `Reply with exactly:` fixture appended to this shot's
// instructions (below), which the mock returns verbatim as the assistant's
// prose. See e2e/README.md on the mock's fixture + tool-name behaviour.
const CHAT_MESSAGE =
  "A customer emailed asking to reset their password. Can you draft a warm, friendly reply?";
const CHAT_REPLY =
  "Hi Jordan, thanks for reaching out! I've just sent a secure reset link to the " +
  "email on file — it stays valid for 30 minutes, so please open it soon. If you " +
  "hit any snags, reply here and we'll be glad to help.";

/**
 * Capture the full window once the page has visually settled: no dock/nav
 * tooltip photobombs (they show on :hover and :focus-within — park the
 * pointer in the empty top-left corner and blur a tooltip-wrapped trigger if
 * one still holds focus; other surfaces, like the instructions editor, keep
 * their focus), no toast is mid-flight (each auto-dismisses within ~5 s —
 * polled, never slept), and the webfonts have finished loading so text
 * metrics are identical run to run.
 */
async function shoot(page: Page, file: string): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".tooltip-wrap")) {
      active.blur();
    }
  });
  await expect(
    page.getByRole("button", { name: "Dismiss notification" }),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({
    path: join(OUT_DIR, file),
    animations: "disabled",
    caret: "hide",
  });
}

test("capture the five product screenshots", async ({ page }) => {
  mkdirSync(OUT_DIR, { recursive: true });
  await signUpIntoWorkspace(page, "screens");

  // ── author the context inventory: one skill + two MCP connections ──────────
  await createSkillWithAttachment(page, {
    name: SKILL_NAME,
    description: "Use when the user asks about tone or writing style.",
    content: "# Brand voice\n\nWarm, concise, plain language.",
    fileName: "template.md",
  });
  await installRegistryConnection(page, {
    name: REGISTRY_CONNECTION,
    query: "notes",
  });
  await addCustomConnection(page, { name: SCAFFOLD_CONNECTION_NAME });

  // ── context.png — /context with two connection cards + one skill row ───────
  await gotoSection(page, "Context");
  await expect(
    page.getByRole("heading", { name: "Context", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: REGISTRY_CONNECTION, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: SCAFFOLD_CONNECTION_NAME, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(`^${SKILL_NAME}`) }),
  ).toBeVisible();
  await shoot(page, "context.png");

  // ── build the workflow: form trigger · 2 context chips · instructions ──────
  await openNewWorkflow(page, WORKFLOW_NAME);
  await setFormTriggerWithTwoFields(page, [
    { key: "email", label: "Customer email" },
    { key: "topic", label: "Topic" },
  ]);
  await attachResource(page, "connection", REGISTRY_CONNECTION);
  await attachResource(page, "connection", SCAFFOLD_CONNECTION_NAME);
  await attachResource(page, "skill", SKILL_NAME);
  // The lead references @notes inline (a real connection ref), then the
  // helper exercises the live `@trigger.` autocomplete pick for the field
  // ref — two resolved @refs land in the instructions. Note: no "\n" may be
  // typed right after an `@` word or the open autocomplete would eat Enter.
  await writeInstructionsWithTriggerRef(page, {
    lead:
      "Triage each inbound support request and draft a concise, friendly reply.\n\n" +
      "Check @notes for related history, then note the sender ",
    triggerField: "email",
  });

  // ── builder.png — all four pillar cards populated, editor focused ──────────
  await expect(railCard(page, "Trigger")).toContainText("Form");
  await expect(railCard(page, "Trigger")).toContainText("2 fields");
  await expect(railCard(page, "Context")).toContainText(REGISTRY_CONNECTION);
  await expect(railCard(page, "Context")).toContainText(
    SCAFFOLD_CONNECTION_NAME,
  );
  await expect(railCard(page, "Context")).toContainText(SKILL_NAME);
  await expect(railCard(page, "Agent")).toContainText("General Purpose");
  await expect(railCard(page, "Instructions")).toContainText("@ref");
  const editor = page.getByRole("textbox", { name: "Instructions editor" });
  await expect(editor).toContainText("@trigger.email");
  await expect(editor).toContainText("@notes");
  // The autocomplete tooltip must be gone (the pick closes it) and the editor
  // focused — the shot shows the instructions pane as the active surface.
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  // Autosave settles first, so the header reads "Saved · compiles clean"
  // rather than a mid-flight "Saving…" spinner + amber "Unsaved" chip.
  await expect(page.getByText("Saved · compiles clean")).toBeVisible();
  await expect(page.getByText("Unsaved", { exact: true })).toBeHidden();
  await editor.focus();
  await expect(editor).toBeFocused();
  await shoot(page, "builder.png");

  // ── publish (real eve build) and run it from chat ──────────────────────────
  // Append the shot-only reply fixture to the (already-photographed) builder
  // instructions, then publish that draft. builder.png was captured above, so
  // this extra line never shows there — it only steers the mock to answer this
  // one chat in clean prose. A space + blank line leads the text so the newline
  // lands cleanly after the trailing `@trigger.email` ref.
  await appendInstructions(page, ` \n\nReply with exactly: ${CHAT_REPLY}`);
  await expect(page.getByText("Saved · compiles clean")).toBeVisible();
  await publishAndWaitReady(page);
  await startChatAndSend(page, WORKFLOW_NAME, CHAT_MESSAGE);

  // ── chat.png — completed run: user question + clean prose reply + sessions ─
  // The message names no built-in tool, so the mock runs no tool step (no
  // working block) and returns the authored draft verbatim. Assert the prose
  // reply rendered — and that the old tool-JSON dump is gone.
  await expect(page.getByText(/sent a secure reset link/i).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await expect(
    page.getByText(/reply here and we'll be glad to help/i).first(),
  ).toBeVisible();
  await expect(page.getByText(/Used todo/i)).toHaveCount(0);
  await expect(page.getByText(/"todos"|"counts"/)).toHaveCount(0);
  // Session list on the left carries the session row with its status dot; the
  // run has settled to Idle (no pending working block).
  const sessionsPanel = page.locator('[aria-label="Chat sessions"]');
  await expect(
    sessionsPanel.getByRole("button", { name: new RegExp(WORKFLOW_NAME) }),
  ).toBeVisible();
  await expect(sessionsPanel.getByRole("img", { name: "Idle" })).toBeVisible();
  await shoot(page, "chat.png");

  // ── copilot.png — rail open, un-applied suggestion with a diff preview ─────
  // Fresh workflow so the scripted scaffold conversation applies cleanly
  // (same fake-LLM script as copilot.e2e.ts). Apply the first two proposals;
  // the third (instructions + inline diff) stays UN-APPLIED for the shot.
  await openNewWorkflow(page, "Copilot scaffold workflow");
  await expect(railCard(page, "Trigger")).toContainText("Manual");
  await openCopilotAndSend(page, SCAFFOLD_PROMPT);

  const triggerCard = page.getByRole("group", {
    name: /^Suggestion: Set trigger: Form/,
  });
  await expect(triggerCard).toBeVisible();
  await triggerCard.getByRole("button", { name: "Apply" }).click();
  await expect(railCard(page, "Trigger")).toContainText("Form");

  const contextCard = page.getByRole("group", {
    name: `Suggestion: Add connection: ${SCAFFOLD_CONNECTION_NAME}`,
  });
  await expect(contextCard).toBeVisible();
  await contextCard.getByRole("button", { name: "Apply" }).click();
  await expect(railCard(page, "Context")).toContainText(
    SCAFFOLD_CONNECTION_NAME,
  );

  const instructionsCard = page.getByRole("group", {
    name: "Suggestion: Write instructions",
  });
  await expect(instructionsCard).toBeVisible();
  const diff = instructionsCard.getByTestId("diff-view");
  await expect(diff).toBeVisible();
  await expect(diff.locator('[data-diff="add"]').first()).toBeVisible();
  await expect(diff).toContainText("@trigger.email");
  // Still pending — Apply is live, and no third "Applied" receipt exists.
  await expect(
    instructionsCard.getByRole("button", { name: "Apply" }),
  ).toBeEnabled();
  await expect(
    page.getByTestId("suggestion-receipt").filter({ hasText: "Applied" }),
  ).toHaveCount(2);
  await instructionsCard.scrollIntoViewIfNeeded();
  await shoot(page, "copilot.png");

  // ── settings.png — /settings → Models: the three preset rows ───────────────
  // (The model allowlist table lives on its own sub-route, /settings/allowlist,
  // reachable via the visible settings nav.)
  await gotoSection(page, "Settings");
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  for (const label of ["Powerful", "Balanced", "Quick"]) {
    await expect(
      page.getByRole("heading", { name: label, level: 3 }),
    ).toBeVisible();
  }
  // Each row carries its seeded "provider · model" chip — never an empty pane.
  await expect(page.getByText(/OpenRouter · /).first()).toBeVisible();
  await shoot(page, "settings.png");
});
