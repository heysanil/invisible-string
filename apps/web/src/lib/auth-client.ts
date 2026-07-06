/**
 * Better Auth browser client. The organization plugin mirrors the server's
 * (apps/control-plane/src/auth.ts): workspace = organization, creator =
 * owner. Member invitations and role changes go through
 * `authClient.organization.*` — the control-plane REST surface only ever
 * READS members (`GET /workspaces/:id/members`).
 */
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// TEMP DIAGNOSTIC (remove before merge): position of this line in grouped
// test output identifies which test file evaluated the REAL module first.
console.log(
  "[diag:real-auth-client] evaluated at",
  new Date().toISOString(),
  "url =",
  import.meta.url,
);

const baseURL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const authClient = createAuthClient({
  baseURL,
  plugins: [organizationClient()],
});

export const {
  useSession,
  signIn,
  signUp,
  signOut,
  useActiveOrganization,
  useListOrganizations,
} = authClient;
