/**
 * Reusable UI + auth flows shared across specs. Everything a spec does that
 * isn't the thing-under-test lives here so the specs read as user stories.
 *
 * Workspace note: the product has no in-UI "create your first workspace"
 * onboarding yet (a signed-up user lands in the shell with "No workspace
 * yet"). Creating the org is therefore setup, not the assertion — we drive it
 * through Better Auth's REST endpoints using the browser context's own
 * session cookie (context.request shares the cookie jar), then let the app's
 * self-healing first-org activation take over. The org-creation hook seeds the
 * locked workspace defaults, so the builder is immediately usable.
 */
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

import { API_BASE_URL } from "../config.ts";

export interface Account {
  name: string;
  email: string;
  password: string;
}

export const PASSWORD = "correct-horse-battery-staple";

export function uniqueAccount(prefix: string): Account {
  const id = randomUUID().slice(0, 8);
  return {
    name: `E2E ${prefix} ${id}`,
    email: `e2e-${prefix}-${id}@example.com`,
    password: PASSWORD,
  };
}

/** Fill and submit the signup form; resolves when the shell (chat) is shown. */
export async function signUp(page: Page, account: Account): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/chat");
}

/** Fill and submit the login form; resolves at the shell (chat). */
export async function login(page: Page, account: Account): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL("**/chat");
}

/**
 * Create a workspace (Better Auth organization) for the currently signed-in
 * session and activate it. Returns the organization id.
 */
export async function createWorkspace(
  page: Page,
  name = "E2E Workspace",
): Promise<string> {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  // Run the Better Auth calls as browser-origin fetches (from the SPA origin):
  // that carries the session cookie AND an Origin header Better Auth trusts —
  // a bare request-context POST is rejected 403 by its origin check.
  const created = await callAuth(page, "/api/auth/organization/create", {
    name,
    slug,
  });
  expect(created.ok, `org create failed: ${created.status}`).toBeTruthy();
  const orgId =
    (created.body as { id?: string; data?: { id?: string } }).id ??
    (created.body as { data?: { id?: string } }).data?.id;
  expect(orgId, "org create returned no id").toBeTruthy();

  const activated = await callAuth(page, "/api/auth/organization/set-active", {
    organizationId: orgId,
  });
  expect(activated.ok, `set-active failed: ${activated.status}`).toBeTruthy();
  return orgId!;
}

/** POST JSON to a Better Auth endpoint from the browser (credentialed). */
async function callAuth(
  page: Page,
  path: string,
  data: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  return page.evaluate(
    async ({ url, payload }) => {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    },
    { url: `${API_BASE_URL}${path}`, payload: data },
  );
}

/** Sign up a fresh user and drop them into a freshly-seeded workspace. */
export async function signUpIntoWorkspace(
  page: Page,
  prefix: string,
): Promise<{ account: Account; orgId: string }> {
  const account = uniqueAccount(prefix);
  await signUp(page, account);
  const orgId = await createWorkspace(page, `${account.name} ws`);
  // Re-enter the shell so the freshly-activated org resolves everywhere.
  await page.goto("/workflows");
  return { account, orgId };
}
