/**
 * Better Auth browser client. The organization plugin mirrors the server's
 * (apps/control-plane/src/auth.ts): workspace = organization, creator =
 * owner. Member invitations and role changes go through
 * `authClient.organization.*` — the control-plane REST surface only ever
 * READS members (`GET /workspaces/:id/members`).
 *
 * This module deliberately exports NO React hooks. `useSession`,
 * `useActiveOrganization`, and `useListOrganizations` are nanostores atoms
 * whose freshness is tied to component mount lifecycle: they report
 * `isPending: false` while holding data they never refetched, their plugin
 * atoms fetch exactly once per page load, and NO signal fires on sign-in — so
 * an atom that resolved while signed out stays 401 until a full reload. That
 * combination is what made users type their password twice and then stare at
 * an empty workspace. Identity comes from `lib/auth/viewer.ts` instead, which
 * uses the plain proxy calls (`authClient.getSession()`,
 * `authClient.organization.list()`) that carry no cache. Guard:
 * `__tests__/auth-client-surface.test.ts`.
 */
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { API_BASE_URL } from "./api-client";

const baseURL = API_BASE_URL;

export const authClient = createAuthClient({
  baseURL,
  plugins: [organizationClient()],
});

export const { signIn, signUp, signOut } = authClient;
