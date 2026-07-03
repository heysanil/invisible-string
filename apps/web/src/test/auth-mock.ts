/**
 * Shared better-auth client mock. Importing this module replaces
 * `src/lib/auth-client` for every subsequent import; tests drive behavior
 * through the mutable `authMockState`.
 *
 * Covers the organization plugin surface too (active workspace, invites,
 * role changes) so settings/context screens render without a live API.
 */
import { mock } from "bun:test";

export interface MockUser {
  id: string;
  email: string;
  name: string;
}

export interface MockSessionData {
  user: MockUser;
}

export interface MockOrganization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface MockAuthError {
  message?: string;
  status?: number;
}

export interface MockAuthResult {
  data: unknown;
  error: MockAuthError | null;
}

const ok = (): MockAuthResult => ({ data: null, error: null });

export const authMockState = {
  session: null as MockSessionData | null,
  pending: false,
  signInResult: ok(),
  signUpResult: ok(),
  signInCalls: [] as Array<Record<string, unknown>>,
  signUpCalls: [] as Array<Record<string, unknown>>,

  // Organization plugin state
  organizations: [] as MockOrganization[],
  activeOrganization: null as MockOrganization | null,
  orgPending: false,
  inviteResult: ok(),
  updateMemberRoleResult: ok(),
  updateOrganizationResult: ok(),
  acceptInvitationResult: ok(),
  listInvitationsResult: { data: [], error: null } as MockAuthResult,
  cancelInvitationResult: ok(),
  inviteCalls: [] as Array<Record<string, unknown>>,
  updateMemberRoleCalls: [] as Array<Record<string, unknown>>,
  setActiveCalls: [] as Array<Record<string, unknown>>,
  updateOrganizationCalls: [] as Array<Record<string, unknown>>,
  acceptInvitationCalls: [] as Array<Record<string, unknown>>,
  cancelInvitationCalls: [] as Array<Record<string, unknown>>,
};

export function resetAuthMock(): void {
  authMockState.session = null;
  authMockState.pending = false;
  authMockState.signInResult = ok();
  authMockState.signUpResult = ok();
  authMockState.signInCalls = [];
  authMockState.signUpCalls = [];

  authMockState.organizations = [];
  authMockState.activeOrganization = null;
  authMockState.orgPending = false;
  authMockState.inviteResult = ok();
  authMockState.updateMemberRoleResult = ok();
  authMockState.updateOrganizationResult = ok();
  authMockState.acceptInvitationResult = ok();
  authMockState.listInvitationsResult = { data: [], error: null };
  authMockState.cancelInvitationResult = ok();
  authMockState.inviteCalls = [];
  authMockState.updateMemberRoleCalls = [];
  authMockState.setActiveCalls = [];
  authMockState.updateOrganizationCalls = [];
  authMockState.acceptInvitationCalls = [];
  authMockState.cancelInvitationCalls = [];
}

export function demoSession(): MockSessionData {
  return { user: { id: "u1", email: "demo@example.com", name: "Demo" } };
}

export function demoWorkspace(): MockOrganization {
  return {
    id: "org_test_1",
    name: "Acme",
    slug: "acme",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

/** Put the mock in the common "signed in with one workspace" shape. */
export function signInToDemoWorkspace(): void {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  authMockState.activeOrganization = demoWorkspace();
}

const authClientPath = new URL("../lib/auth-client.ts", import.meta.url).pathname;

const organizationMock = {
  setActive: async (args: Record<string, unknown>) => {
    authMockState.setActiveCalls.push(args);
    const next = authMockState.organizations.find(
      (org) => org.id === args["organizationId"],
    );
    authMockState.activeOrganization = next ?? null;
    return ok();
  },
  inviteMember: async (args: Record<string, unknown>) => {
    authMockState.inviteCalls.push(args);
    return authMockState.inviteResult;
  },
  updateMemberRole: async (args: Record<string, unknown>) => {
    authMockState.updateMemberRoleCalls.push(args);
    return authMockState.updateMemberRoleResult;
  },
  update: async (args: Record<string, unknown>) => {
    authMockState.updateOrganizationCalls.push(args);
    return authMockState.updateOrganizationResult;
  },
  listInvitations: async () => authMockState.listInvitationsResult,
  acceptInvitation: async (args: Record<string, unknown>) => {
    authMockState.acceptInvitationCalls.push(args);
    return authMockState.acceptInvitationResult;
  },
  cancelInvitation: async (args: Record<string, unknown>) => {
    authMockState.cancelInvitationCalls.push(args);
    return authMockState.cancelInvitationResult;
  },
};

const useActiveOrganization = () => ({
  data: authMockState.activeOrganization,
  isPending: authMockState.orgPending,
  error: null,
  refetch: () => {},
});

const useListOrganizations = () => ({
  data: authMockState.organizations,
  isPending: authMockState.orgPending,
  error: null,
  refetch: () => {},
});

mock.module(authClientPath, () => ({
  authClient: { organization: organizationMock },
  useSession: () => ({
    data: authMockState.session,
    isPending: authMockState.pending,
    error: null,
    refetch: () => {},
  }),
  useActiveOrganization,
  useListOrganizations,
  signIn: {
    email: async (args: Record<string, unknown>) => {
      authMockState.signInCalls.push(args);
      return authMockState.signInResult;
    },
  },
  signUp: {
    email: async (args: Record<string, unknown>) => {
      authMockState.signUpCalls.push(args);
      return authMockState.signUpResult;
    },
  },
  signOut: async () => ok(),
}));
