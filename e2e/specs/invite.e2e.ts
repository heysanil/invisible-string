/**
 * Invite acceptance: owner invites by email → copies the surfaced link →
 * a brand-new user opens it, is bounced through signup (redirect param),
 * accepts, and lands in the shared workspace. Exercises the whole
 * "join" half of onboarding end-to-end.
 */
import { expect, test } from "@playwright/test";

import {
  createWorkspaceViaOnboarding,
  signUp,
  uniqueAccount,
} from "../support/flows.ts";

test("invite link round-trip: signup through redirect, accept, appear in members", async ({
  browser,
  page,
}) => {
  const owner = uniqueAccount("invite-owner");
  const invitee = uniqueAccount("invite-joiner");

  // ── owner: workspace + invite ─────────────────────────────────────────
  await signUp(page, owner);
  await createWorkspaceViaOnboarding(page, `${owner.name} ws`);
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill(invitee.email);
  await page.getByRole("button", { name: /invite/i }).click();
  const linkText = await page
    .locator("code", { hasText: "/accept-invitation/" })
    .textContent();
  expect(linkText, "invite link not surfaced").toBeTruthy();
  const invitePath = new URL(linkText!.trim()).pathname;

  // ── invitee: fresh context, no account ────────────────────────────────
  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  await inviteePage.goto(invitePath);
  await inviteePage.waitForURL("**/login**");

  // No account yet — the signup hop must preserve the redirect param.
  await inviteePage.getByRole("link", { name: /create one/i }).click();
  await inviteePage.getByLabel("Name").fill(invitee.name);
  await inviteePage.getByLabel("Email").fill(invitee.email);
  await inviteePage.getByLabel("Password").fill(invitee.password);
  await inviteePage
    .getByRole("button", { name: /create account/i })
    .click();

  // ── back on the invitation, signed in: accept ─────────────────────────
  await inviteePage.waitForURL("**/accept-invitation/**");
  await expect(
    inviteePage.getByRole("heading", { name: /^Join / }),
  ).toBeVisible();
  await inviteePage
    .getByRole("button", { name: /accept invitation/i })
    .click();
  await inviteePage.waitForURL("**/chat");
  await expect(
    inviteePage.getByRole("navigation", { name: "Primary" }),
  ).toBeVisible();

  // ── owner sees the new member ─────────────────────────────────────────
  await page.reload();
  await expect(page.getByText(invitee.email).first()).toBeVisible();

  await inviteeContext.close();
});
