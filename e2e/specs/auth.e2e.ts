/**
 * Auth acceptance: signup → first-run workspace onboarding → shell; logout;
 * login. Exercises the real Better Auth email/password flow end-to-end
 * through the browser.
 */
import { expect, test } from "@playwright/test";

import { API_BASE_URL } from "../config.ts";
import {
  createWorkspace,
  createWorkspaceViaOnboarding,
  login,
  signUp,
  uniqueAccount,
} from "../support/flows.ts";

test("signup drives first-run onboarding into the shell, then logout and login round-trip", async ({
  page,
}) => {
  const account = uniqueAccount("auth");

  // ── signup → first-run onboarding → shell ───────────────────────────────
  await signUp(page, account);
  await expect(page).toHaveURL(/\/chat$/);
  // A fresh account owns no workspace: onboarding replaces the shell.
  await expect(
    page.getByRole("heading", { name: "Create your workspace" }),
  ).toBeVisible();
  await createWorkspaceViaOnboarding(page, `${account.name} ws`);
  const dock = page.getByRole("navigation", { name: "Primary" });
  await expect(dock).toBeVisible();
  await expect(dock.getByRole("link", { name: "Chat" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // ── logout ────────────────────────────────────────────────────────────────
  await page.goto("/settings/workspace");
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL("**/login");
  await expect(
    page.getByRole("button", { name: /^sign in$/i }),
  ).toBeVisible();

  // ── login → shell ─────────────────────────────────────────────────────────
  await login(page, account);
  await expect(page).toHaveURL(/\/chat$/);
  await expect(
    page.getByRole("navigation", { name: "Primary" }),
  ).toBeVisible();
});

test("login rejects a bad password without leaving the login page", async ({
  page,
}) => {
  const account = uniqueAccount("auth-bad");
  await signUp(page, account);
  // Sign out via the API so we can re-test the login form's error path.
  await page.context().request.post(`${API_BASE_URL}/api/auth/sign-out`);

  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill("wrong-password-000");
  await page.getByRole("button", { name: /^sign in$/i }).click();

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

/**
 * Deliberately does NOT start with `page.goto("/login")` (the way `login()`
 * does, `e2e/support/flows.ts:48`). That full navigation rebuilds the SPA's
 * Better Auth client and query-cache singletons from scratch right at the
 * login form — which erases exactly the stale state a real "hit a protected
 * route while signed out, got redirected" visit leaves behind, and is why
 * CI never caught the double-login bug this covers. Instead this reaches
 * `/login` the way a real user does: `/chat` while signed out, and let
 * `_app`'s own `beforeLoad` gate issue the redirect.
 */
test("signing in once resolves a protected route reached while signed out, without a reload", async ({
  page,
}) => {
  const account = uniqueAccount("auth-redirect");
  await signUp(page, account);
  await createWorkspace(page, `${account.name} ws`);

  // Sign out through the UI so the tab is genuinely signed out — server
  // session dropped — before the redirect case below.
  await page.goto("/settings/workspace");
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL("**/login");

  // The case under test — see the comment above the test.
  await page.goto("/chat");
  await page.waitForURL(/\/login/);

  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  await page.waitForURL("**/chat");
  // Real, workspace-scoped shell content — not merely the URL.
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
});
