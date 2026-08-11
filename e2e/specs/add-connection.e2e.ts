/**
 * The add-connection dialog journeys (connectors redesign spec §10, v1 scope)
 * against the real stack, as one serial user story:
 *
 *   1. CATALOG lane — the checked-in curated catalog renders with zero
 *      network calls: featured row + category tiles for the seeded entries.
 *   2. COMMUNITY search — the single search field hits the control plane's
 *      Meilisearch mirror (fed by the registry→Meilisearch sync ETL from the
 *      stubbed official registry): the stub server surfaces with its Verified
 *      badge, and its declared secret header gates the install behind a
 *      one-shot credential form. The card appears named after the server
 *      title (community installs have no name field).
 *   3. CUSTOM URL — bring-your-own server on a DISTINCT stub path, card
 *      appears.
 *   4. The FULL SPINE on `cn_` ids — attach the community connection to an
 *      agent, publish (real eve build compiled FROM the `cn_`-id,
 *      secret-bearing connection row), chat: the run streams a working block
 *      and the final prose arrives — compile and dispatch both work on the
 *      rebuilt connections domain end-to-end.
 *
 * The chat run is driven with eve's BUILT-IN `todo` tool, not the stub's MCP
 * tool: the deterministic mock model exposes built-in tools to the top-level
 * model but routes MCP connection tools behind a `connection_search`
 * sub-agent it never delegates to — under the mock the compiled agent never
 * even opens an MCP session to the stub (connections attach lazily through
 * that sub-agent), so no MCP-wire assertion is possible here (see the README
 * note and agent-workflow.e2e.ts).
 *
 * Search DEGRADATION (`search_unavailable`) is deliberately not exercised:
 * it would need a second control-plane boot without MEILISEARCH_URL, which
 * this harness has no cheap way to do — the typed-503 path is covered by the
 * control plane's registry-search unit test and the dialog's unit test.
 */
import { expect, test } from "@playwright/test";

import {
  REGISTRY_SECRET_HEADER,
  REGISTRY_SECRET_VALUE,
  REGISTRY_SERVER_TITLE,
} from "../config.ts";
import { addCustomConnection, gotoSection } from "../support/authoring.ts";
import {
  attachAgentResource,
  openNewAgent,
  publishAgentAndWaitReady,
  startChatAndSend,
  writePersona,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

/** Seeded catalog entries (packages/shared/src/connector-catalog.json). */
const CATALOG_TITLES = ["DeepWiki", "Context7", "Hugging Face", "Stripe"];
const CUSTOM_CONNECTION = "notes";
const AGENT_NAME = "Connections spine agent";

test("add connections via catalog, community search, and custom URL; the community install rides the full spine", async ({
  page,
}) => {
  await signUpIntoWorkspace(page, "connections");

  // ── 1. catalog lane: seeded entries render (zero network calls) ────────────
  await gotoSection(page, "Context");
  await page.getByRole("button", { name: "Add connection" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add connection" });
  await expect(dialog.getByRole("heading", { name: "Featured" })).toBeVisible();
  for (const title of CATALOG_TITLES) {
    await expect(
      dialog.getByRole("button", { name: `Add ${title}` }),
    ).toBeVisible();
  }

  // ── 2. community search: Verified badge, secret-gated install ──────────────
  await dialog
    .getByRole("textbox", { name: "Search connectors" })
    .fill(REGISTRY_SERVER_TITLE);
  const result = dialog.getByRole("button", {
    name: new RegExp(REGISTRY_SERVER_TITLE),
  });
  await expect(result).toBeVisible();
  await expect(result.getByText("Verified")).toBeVisible();
  await result.click();

  // The remote's declared secret header re-titles the dialog to a one-shot
  // credential form; the install goes through with the secret exactly once.
  const configure = page.getByRole("dialog", { name: "Configure server" });
  await configure
    .getByLabel(REGISTRY_SECRET_HEADER)
    .fill(REGISTRY_SECRET_VALUE);
  // exact: the back button "All connectors" substring-matches "Connect".
  await configure
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await expect(configure).toBeHidden();

  // Community installs are named after the server title (no name field).
  await expect(
    page.getByRole("heading", { name: REGISTRY_SERVER_TITLE, exact: true }),
  ).toBeVisible();

  // ── 3. custom URL (the stub's /mcp — distinct from the community /mcp-b) ───
  await addCustomConnection(page, { name: CUSTOM_CONNECTION });

  // ── 4. the full spine on cn_ ids: attach → publish → chat ──────────────────
  await openNewAgent(page, AGENT_NAME);
  await writePersona(
    page,
    "You keep tidy notes and plans; make lists before you act.",
  );
  await attachAgentResource(page, "connection", REGISTRY_SERVER_TITLE);
  await publishAgentAndWaitReady(page);

  // The mock-reachable `todo` tool yields a real streamed step + prose reply.
  await startChatAndSend(
    page,
    AGENT_NAME,
    "Make a todo list for the triage steps, then summarize the plan.",
  );
  await expect(
    page.getByRole("button", { name: /Work(ing|ed)/ }).first(),
  ).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await expect(page.getByText(/Used todo/i).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
});
