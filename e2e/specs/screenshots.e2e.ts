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
 * explicit publish (the agent's real eve build; the seeded "General Purpose"
 * agent builds itself in the background and the copilot shot waits on it).
 * Two shots ride outside that single workspace: onboarding.png is captured
 * on first-run, before the workspace exists (the signup that seeds the rest
 * of the run happens through this same screen); invite.png is captured from
 * a second, unauthenticated browser context that drives an invited user
 * through login/signup up to — but never past — the accept-invitation
 * confirm panel, so the pending invite stays inert. Every shot first asserts
 * the state it photographs — the same assertions the acceptance specs use —
 * because a blank pane is a failure, not a deliverable. Captures are
 * full-window at 1600×1000, deviceScaleFactor 2 (crisp retina), with
 * animations force-completed and the caret hidden at shot time.
 */
import { randomUUID } from "node:crypto";
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
  appendPersona,
  attachAgentResource,
  openNewAgent,
  openNewWorkflow,
  publishAgentAndWaitReady,
  publishWorkflow,
  selectWorkflowAgent,
  setAgentModelPreset,
  setFormTriggerWithTwoFields,
  startChatAndSend,
  waitForAgentPublished,
  writeInstructionsWithTriggerRef,
  writePersona,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import {
  SCAFFOLD_AGENT_NAME,
  SCAFFOLD_PROMPT,
} from "../support/copilot-script.ts";
import { agentRailCard, openCopilotAndSend } from "../support/copilot.ts";
import { signUp, uniqueAccount } from "../support/flows.ts";

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

const WORKSPACE_NAME = "Acme Support";
const AGENT_NAME = "Support Concierge";
const AGENT_DESCRIPTION = "Front-line support triage and warm, on-brand replies.";
const WORKFLOW_NAME = "Support triage workflow";
const REGISTRY_CONNECTION = "Registry notes";
const CUSTOM_CONNECTION = "notes";
const SKILL_NAME = "Brand voice";

// The agent's persona document — this IS the agent, so it reads like one.
// (@notes is a real attached-connection reference; the persona editor has no
// autocomplete, it is typed verbatim.)
const AGENT_PERSONA =
  "You are Acme's support concierge — the first voice a customer hears.\n\n" +
  "Triage every inbound request, check @notes for related history, and draft " +
  "warm, concise replies in plain language. Escalate anything irreversible to " +
  "a human before acting.";

// The chat shot photographs a real published run replying in clean prose — a
// support-triage draft, not a tool-JSON dump. The message reads naturally (no
// built-in tool name, so eve's mock never fires the working block); the reply
// text is authored as a `Reply with exactly:` fixture appended to the PERSONA
// after agents.png is captured (below), which the mock returns verbatim as
// the assistant's prose. See e2e/README.md on the mock's fixture + tool-name
// behaviour.
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

test("capture the eight product screenshots", async ({ page, browser }) => {
  mkdirSync(OUT_DIR, { recursive: true });

  // A designed identity for the owner — invite.png's subtitle shows this
  // email ("… invited you to this workspace"), so it must read like a real
  // person's address, while the random suffix keeps repeat runs unique.
  const account = {
    ...uniqueAccount("screens"),
    name: "Jordan Lee",
    email: `jordan-${randomUUID().slice(0, 8)}@acme.dev`,
  };
  await signUp(page, account);
  // ── onboarding.png — first-run create-workspace card over the wash ────────
  await expect(
    page.getByRole("heading", { name: "Create your workspace" }),
  ).toBeVisible();
  await page.getByLabel("Workspace name").fill(WORKSPACE_NAME);
  await shoot(page, "onboarding.png");
  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(
    page.getByRole("navigation", { name: "Primary" }),
  ).toBeVisible();
  await page.goto("/agents");

  // ── invite.png — invite confirm panel, viewed by a not-yet-joined invitee ──
  const invitee = uniqueAccount("invitee");
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill(invitee.email);
  await page.getByRole("button", { name: /invite/i }).click();
  const linkText = await page
    .locator("code", { hasText: "/accept-invitation/" })
    .textContent();
  expect(linkText, "invite link not surfaced").toBeTruthy();
  const invitePath = new URL(linkText!.trim()).pathname;

  const inviteeContext = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  const inviteePage = await inviteeContext.newPage();
  await inviteePage.goto(invitePath);
  await inviteePage.waitForURL("**/login**");

  // No account yet — the signup hop must preserve the redirect param.
  await inviteePage.getByRole("link", { name: /create one/i }).click();
  await inviteePage.getByLabel("Name").fill(invitee.name);
  await inviteePage.getByLabel("Email").fill(invitee.email);
  await inviteePage.getByLabel("Password").fill(invitee.password);
  await inviteePage.getByRole("button", { name: /create account/i }).click();

  // ── back on the invitation, signed in: assert the confirm panel, shoot ─────
  await inviteePage.waitForURL("**/accept-invitation/**");
  await expect(
    inviteePage.getByRole("heading", { name: `Join ${WORKSPACE_NAME}` }),
  ).toBeVisible();
  await expect(inviteePage.getByText("member", { exact: true })).toBeVisible();
  await expect(
    inviteePage.getByRole("button", { name: /accept invitation/i }),
  ).toBeEnabled();
  await shoot(inviteePage, "invite.png");
  // Never accept — the pending invitation stays inert.
  await inviteeContext.close();

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
  await addCustomConnection(page, { name: CUSTOM_CONNECTION });

  // ── context.png — /context with two connection cards + one skill row ───────
  await gotoSection(page, "Context");
  await expect(
    page.getByRole("heading", { name: "Context", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: REGISTRY_CONNECTION, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: CUSTOM_CONNECTION, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(`^${SKILL_NAME}`) }),
  ).toBeVisible();
  await shoot(page, "context.png");

  // ── hire the agent: persona · model · context (the flagship editor) ────────
  await openNewAgent(page, AGENT_NAME);
  await page.getByLabel("Description").fill(AGENT_DESCRIPTION);
  await attachAgentResource(page, "connection", REGISTRY_CONNECTION);
  await attachAgentResource(page, "connection", CUSTOM_CONNECTION);
  await attachAgentResource(page, "skill", SKILL_NAME);
  await writePersona(page, AGENT_PERSONA);
  await setAgentModelPreset(page, "Balanced");

  // ── agents.png — the agent editor, every rail card live ────────────────────
  await expect(agentRailCard(page, "Persona")).toContainText(
    "support concierge",
  );
  await expect(agentRailCard(page, "Model")).toContainText("Balanced");
  await expect(agentRailCard(page, "Context")).toContainText(REGISTRY_CONNECTION);
  await expect(agentRailCard(page, "Context")).toContainText(CUSTOM_CONNECTION);
  await expect(agentRailCard(page, "Context")).toContainText(SKILL_NAME);
  await expect(agentRailCard(page, "Access")).toContainText("Runs as");
  // Autosave settles first, so the header reads "Saved" rather than a
  // mid-flight "Saving…" spinner.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await shoot(page, "agents.png");

  // ── publish the agent (real eve build) and chat with it ────────────────────
  // Append the shot-only reply fixture to the (already-photographed) persona,
  // then publish that draft. agents.png was captured above, so this extra
  // line never shows there — it only steers the mock to answer this one chat
  // in clean prose.
  await appendPersona(page, `\n\nReply with exactly: ${CHAT_REPLY}`);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await publishAgentAndWaitReady(page);
  await startChatAndSend(page, AGENT_NAME, CHAT_MESSAGE);

  // ── chat.png — completed run: user question + clean prose reply + sessions ─
  // The message names no built-in tool, so the mock runs no tool step (no
  // working block) and returns the authored draft verbatim. Assert the prose
  // reply rendered — and that no tool-JSON dump did.
  await expect(page.getByText(/sent a secure reset link/i).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await expect(
    page.getByText(/reply here and we'll be glad to help/i).first(),
  ).toBeVisible();
  await expect(page.getByText(/Used todo/i)).toHaveCount(0);
  await expect(page.getByText(/"todos"|"counts"/)).toHaveCount(0);
  // Session list on the left carries the agent-named session row with its
  // status dot; the run has settled to Idle (no pending working block).
  const sessionsPanel = page.locator('[aria-label="Chat sessions"]');
  await expect(
    sessionsPanel.getByRole("button", { name: new RegExp(AGENT_NAME) }),
  ).toBeVisible();
  await expect(sessionsPanel.getByRole("img", { name: "Idle" })).toBeVisible();
  await shoot(page, "chat.png");

  // ── workflow.png — the delegation editor: trigger → agent → instructions ───
  await openNewWorkflow(page, WORKFLOW_NAME);
  await setFormTriggerWithTwoFields(page, [
    { key: "email", label: "Customer email" },
    { key: "topic", label: "Topic" },
  ]);
  await selectWorkflowAgent(page, AGENT_NAME);
  // The lead references @notes inline (a real connection ref on the SELECTED
  // agent's context), then the helper exercises the live `@trigger.`
  // autocomplete pick for the field ref — two resolved @refs land in the
  // instructions. Note: no "\n" may be typed right after an `@` word or the
  // open autocomplete would eat Enter.
  await writeInstructionsWithTriggerRef(page, {
    lead:
      "Triage each inbound support request and draft a concise, friendly reply.\n\n" +
      "Check @notes for related history, then note the sender ",
    triggerField: "email",
  });

  // All three sections populated; instant publish flips the header chip to
  // the green "Published" state for the shot.
  const editor = page.getByRole("textbox", { name: "Instructions editor" });
  await expect(editor).toContainText("@trigger.email");
  await expect(editor).toContainText("@notes");
  // The autocomplete tooltip must be gone (the pick closes it).
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await publishWorkflow(page);
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
  // The instructions editor focused — the shot shows it as the active surface.
  await editor.focus();
  await expect(editor).toBeFocused();
  await shoot(page, "workflow.png");

  // ── copilot.png — dock open, un-applied suggestion with a diff preview ─────
  // Fresh workflow so the scripted scaffold conversation applies cleanly
  // (same fake-LLM script as copilot.e2e.ts — its setAgent step targets the
  // seeded "General Purpose" agent, so wait for its background build first).
  // Apply the first two proposals; the third (instructions + inline diff)
  // stays UN-APPLIED for the shot.
  await waitForAgentPublished(page, SCAFFOLD_AGENT_NAME);
  await openNewWorkflow(page, "Copilot scaffold workflow");
  await openCopilotAndSend(page, SCAFFOLD_PROMPT);

  const triggerCard = page.getByRole("group", {
    name: /^Suggestion: Set trigger: Form/,
  });
  await expect(triggerCard).toBeVisible();
  await triggerCard.getByRole("button", { name: "Apply" }).click();
  await expect(
    page
      .getByRole("radiogroup", { name: "Trigger type" })
      .getByRole("radio", { name: "Form" }),
  ).toHaveAttribute("aria-checked", "true");

  const agentCard = page.getByRole("group", {
    name: `Suggestion: Set agent: ${SCAFFOLD_AGENT_NAME}`,
  });
  await expect(agentCard).toBeVisible();
  await agentCard.getByRole("button", { name: "Apply" }).click();
  await expect(
    page
      .getByRole("radiogroup", { name: "Agent" })
      .getByRole("radio", { name: new RegExp(`^${SCAFFOLD_AGENT_NAME}\\b`) }),
  ).toHaveAttribute("aria-checked", "true");

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
