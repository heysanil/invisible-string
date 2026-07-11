/**
 * Context-section authoring flows: create an authored skill with a file
 * attachment, install an MCP connection from the (stubbed) registry browser,
 * and add a custom-URL connection. All drive the real Context UI.
 */
import { expect, type Page } from "@playwright/test";

import { STUB_MCP_URL } from "../config.ts";

/** Click a primary-dock section by its accessible name. */
export async function gotoSection(
  page: Page,
  name: "Chat" | "Agents" | "Workflows" | "Context" | "Settings",
): Promise<void> {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name })
    .click();
}

/**
 * Create a workspace-scoped skill and attach one file to it. Leaves the app on
 * the Context home. Returns the skill's display name.
 */
export async function createSkillWithAttachment(
  page: Page,
  opts: { name: string; description: string; content: string; fileName: string },
): Promise<string> {
  await gotoSection(page, "Context");
  await expect(page.getByRole("heading", { name: "Context", level: 1 })).toBeVisible();

  // Open the "New skill" modal (header button; may co-exist with an empty-state
  // one — take the first).
  await page.getByRole("button", { name: "New skill" }).first().click();
  const modal = page.getByRole("dialog", { name: "New skill" });
  await modal.getByLabel("Name").fill(opts.name);
  await modal.getByLabel("Description (optional)").fill(opts.description);
  await modal.getByRole("button", { name: "Create" }).click();

  // The editor opens for the new skill.
  await page.waitForURL("**/context/skills/**");
  const editor = page.getByRole("textbox", { name: "Skill instructions (markdown)" });
  await editor.click();
  await page.keyboard.type(opts.content);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Attach a file (the input is hidden behind a "browse" button; drive it
  // directly — Playwright sets files on hidden inputs).
  await page.locator('input[type="file"]').setInputFiles({
    name: opts.fileName,
    mimeType: "text/markdown",
    buffer: Buffer.from(`# ${opts.name}\n\nReference material for the agent.\n`),
  });
  await expect(
    page.getByRole("complementary", { name: "Attachments" }).getByText(opts.fileName),
  ).toBeVisible();

  await gotoSection(page, "Context");
  return opts.name;
}

/** Add a custom-URL MCP connection (no auth) pointing at the stub server. */
export async function addCustomConnection(
  page: Page,
  opts: { name: string; url?: string },
): Promise<string> {
  await gotoSection(page, "Context");
  await page.getByRole("button", { name: "Add connection" }).first().click();

  const modal = page.getByRole("dialog", { name: "Add connection" });
  await modal.getByRole("tab", { name: "Custom URL" }).click();
  await modal.getByLabel("Connection name").fill(opts.name);
  await modal.getByLabel("Server URL").fill(opts.url ?? STUB_MCP_URL);
  await modal.getByRole("button", { name: "Add connection" }).click();

  // Modal closes on success; the card appears in the grid.
  await expect(modal).toBeHidden();
  await expect(
    page.getByRole("heading", { name: opts.name, exact: true }),
  ).toBeVisible();
  return opts.name;
}

/**
 * Install a connection from the registry browser. The control-plane's registry
 * proxy is redirected (MCP_REGISTRY_BASE_URL) at the local stub, so both the
 * search and the server-side install re-fetch resolve against the stub — the
 * real registry is never contacted. Returns the installed connection's name.
 */
export async function installRegistryConnection(
  page: Page,
  opts: { name: string; query?: string },
): Promise<string> {
  await gotoSection(page, "Context");
  await page.getByRole("button", { name: "Add connection" }).first().click();

  const modal = page.getByRole("dialog", { name: "Add connection" });
  // Registry tab is the default; search, then pick the canned server card.
  await modal.getByRole("tab", { name: "Registry" }).click();
  await modal
    .getByRole("textbox", { name: "Search the MCP registry" })
    .fill(opts.query ?? "notes");
  await modal.getByRole("button", { name: /E2E Notes \(registry\)/ }).click();

  // Selecting a server re-titles the SAME dialog to "Configure server"
  // (secret-free canned server) — just name + Install.
  const configure = page.getByRole("dialog", { name: "Configure server" });
  await configure.getByLabel("Connection name").fill(opts.name);
  await configure.getByRole("button", { name: "Install" }).click();

  await expect(configure).toBeHidden();
  await expect(
    page.getByRole("heading", { name: opts.name, exact: true }),
  ).toBeVisible();
  return opts.name;
}
