/**
 * Context-section authoring flows: create an authored skill with a file
 * attachment, install a community server through the add-connection dialog's
 * search lane (backed by the Meilisearch mirror of the stubbed registry), and
 * add a custom-URL connection. All drive the real Context UI.
 */
import { expect, type Page } from "@playwright/test";

import {
  REGISTRY_SECRET_HEADER,
  REGISTRY_SECRET_VALUE,
  REGISTRY_SERVER_TITLE,
  STUB_MCP_URL,
} from "../config.ts";

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

  // The browse view leads with the curated catalog; the custom lane sits at
  // the bottom and re-titles the SAME dialog to "Add custom server".
  const modal = page.getByRole("dialog", { name: "Add connection" });
  await modal.getByRole("button", { name: "Add a custom server" }).click();

  const custom = page.getByRole("dialog", { name: "Add custom server" });
  await custom.getByLabel("Connection name").fill(opts.name);
  await custom.getByLabel("Server URL").fill(opts.url ?? STUB_MCP_URL);
  await custom.getByRole("button", { name: "Add connection" }).click();

  // Modal closes on success; the card appears in the grid.
  await expect(custom).toBeHidden();
  await expect(
    page.getByRole("heading", { name: opts.name, exact: true }),
  ).toBeVisible();
  return opts.name;
}

/**
 * Wait (on /context, via a reload poll) until the named connection's card
 * shows the green "Healthy" dot — i.e. the fire-and-forget after-create probe
 * has landed and cached the server's `tools/list`. Pipeline TOOL steps (and
 * the copilot's tool-catalog read tools) key off that cache, so specs that
 * drive either wait here first. The probe persists out-of-band server-side;
 * the SPA has no push channel for it, hence the reload.
 */
export async function waitForConnectionHealthy(
  page: Page,
  connectionName: string,
): Promise<void> {
  await gotoSection(page, "Context");
  const card = page.getByRole("button", { name: `${connectionName} details` });
  await expect(async () => {
    await page.reload();
    await expect(card).toBeVisible({ timeout: 4_000 });
    await expect(card.getByTitle("Healthy")).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 60_000 });
}

/**
 * Install the stub registry server through the add-connection dialog's
 * community-search lane. The search is served by the control plane's
 * Meilisearch mirror (fed by the sync ETL from the stubbed registry, awaited
 * in global-setup); the install re-fetch resolves against the stub via
 * MCP_REGISTRY_BASE_URL — the real registry is never contacted. The remote
 * declares a secret header, so the credential form gates the install.
 *
 * Returns the connection's name — DERIVED from the server title (the dialog
 * has no name field for community installs).
 */
export async function installRegistryConnection(
  page: Page,
  opts: { query?: string } = {},
): Promise<string> {
  await gotoSection(page, "Context");
  await page.getByRole("button", { name: "Add connection" }).first().click();

  const modal = page.getByRole("dialog", { name: "Add connection" });
  await modal
    .getByRole("textbox", { name: "Search connectors" })
    .fill(opts.query ?? REGISTRY_SERVER_TITLE);
  await modal
    .getByRole("button", { name: new RegExp(REGISTRY_SERVER_TITLE) })
    .click();

  // The declared secret header re-titles the SAME dialog to "Configure
  // server" with a one-shot credential form.
  const configure = page.getByRole("dialog", { name: "Configure server" });
  await configure
    .getByLabel(REGISTRY_SECRET_HEADER)
    .fill(REGISTRY_SECRET_VALUE);
  // exact: the back button "All connectors" substring-matches "Connect".
  await configure.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(configure).toBeHidden();
  await expect(
    page.getByRole("heading", { name: REGISTRY_SERVER_TITLE, exact: true }),
  ).toBeVisible();
  return REGISTRY_SERVER_TITLE;
}
