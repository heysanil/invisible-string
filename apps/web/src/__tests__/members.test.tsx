/**
 * Members role gating: owners/admins get a role selector per teammate and an
 * invite row; a plain member sees a read-only roster with role chips only.
 */
import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, waitFor } from "@testing-library/react";

import {
  authMockState,
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";
import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { MembersPanel } from "../components/settings/MembersPanel";

ensureDomForThisFile();
// Re-register in THIS file: module-mock patches don't survive test-file
// boundaries when the real module was evaluated first (order-dependent).
registerAuthMock();

const NOW = "2026-07-03T00:00:00.000Z";

const MEMBERS = {
  members: [
    {
      id: "m_owner",
      userId: "u1",
      name: "Ada Owner",
      email: "ada@acme.dev",
      role: "owner",
      createdAt: NOW,
    },
    {
      id: "m_member",
      userId: "u2",
      name: "Ben Member",
      email: "ben@acme.dev",
      role: "member",
      createdAt: NOW,
    },
  ],
};

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  authMockState.session = { user: { id: "u1", email: "ada@acme.dev", name: "Ada Owner" } };
  fetchMock = installFetchMock();
  fetchMock.on("GET", "/members", () => jsonResponse(MEMBERS));
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

test("owner sees a role selector for teammates and an invite row", async () => {
  const view = renderWithProviders(
    <MembersPanel workspaceId="org_1" canManage currentUserId="u1" />,
  );

  await view.findByText("Ben Member");
  // The teammate's role is editable via a labelled select.
  expect(view.getByLabelText("Role for ben@acme.dev")).toBeTruthy();
  // The owner (self) is not editable — shown as a chip.
  expect(view.getByText("Owner")).toBeTruthy();
  // Invite affordance present.
  expect(view.getByText("Invite a teammate")).toBeTruthy();
});

test("a member sees a read-only roster — chips, no selectors or invite", async () => {
  const view = renderWithProviders(
    <MembersPanel workspaceId="org_1" canManage={false} currentUserId="u2" />,
  );

  await view.findByText("Ben Member");
  await waitFor(() => {
    expect(view.queryByText("Invite a teammate")).toBeNull();
  });
  expect(view.queryByLabelText("Role for ben@acme.dev")).toBeNull();
  // Roles are still visible as chips.
  expect(view.getByText("Owner")).toBeTruthy();
  expect(view.getByText("Member")).toBeTruthy();
});
