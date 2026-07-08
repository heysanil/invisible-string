/**
 * Shared better-auth client mock replacing `src/lib/auth-client`; tests drive
 * behavior through the mutable `authMockState`. Consuming test files must
 * call `registerAuthMock()` at their own top level — importing this module is
 * not enough (see the function's doc comment).
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
  /** Better Auth login session — carries the active organization (= workspace). */
  session?: { activeOrganizationId?: string | null };
}

/** Active workspace id the demo session runs in (workspace-scoped screens). */
export const DEMO_WORKSPACE_ID = "org_test_1";

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
  createOrganizationResult: ok(),
  getInvitationResult: {
    data: null,
    error: { message: "Invitation not found!", status: 400 },
  } as MockAuthResult,
  rejectInvitationResult: ok(),
  createOrganizationCalls: [] as Array<Record<string, unknown>>,
  getInvitationCalls: [] as Array<Record<string, unknown>>,
  rejectInvitationCalls: [] as Array<Record<string, unknown>>,
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
  authMockState.createOrganizationResult = ok();
  authMockState.getInvitationResult = {
    data: null,
    error: { message: "Invitation not found!", status: 400 },
  };
  authMockState.rejectInvitationResult = ok();
  authMockState.createOrganizationCalls = [];
  authMockState.getInvitationCalls = [];
  authMockState.rejectInvitationCalls = [];
}

export function demoSession(): MockSessionData {
  return {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: DEMO_WORKSPACE_ID },
  };
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
    const id = args["organizationId"] as string;
    const known = authMockState.organizations.find((org) => org.id === id);
    // Unknown id: mirror the real client — the active-org store refetches
    // from the server, which knows orgs the (stale) list hook does not,
    // e.g. right after accepting an invitation.
    authMockState.activeOrganization =
      known ??
      (id
        ? { id, name: id, slug: id, createdAt: "2026-07-08T00:00:00.000Z" }
        : null);
    return ok();
  },
  create: async (args: Record<string, unknown>) => {
    authMockState.createOrganizationCalls.push(args);
    const result = authMockState.createOrganizationResult;
    if (!result.error && result.data) {
      // Mirror the real client: /organization/create fires $listOrg, so
      // list hooks re-read — append so layout gates flip in tests.
      authMockState.organizations = [
        ...authMockState.organizations,
        result.data as MockOrganization,
      ];
    }
    return result;
  },
  getInvitation: async (args: Record<string, unknown>) => {
    authMockState.getInvitationCalls.push(args);
    return authMockState.getInvitationResult;
  },
  rejectInvitation: async (args: Record<string, unknown>) => {
    authMockState.rejectInvitationCalls.push(args);
    return authMockState.rejectInvitationResult;
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

/**
 * Register the auth-client module mock. Every test file that depends on the
 * mock MUST call this at its own top level (before dynamically importing
 * route modules): bun applies `mock.module` differently depending on whether
 * the real module has already been evaluated — a clean interception persists
 * across test files, but an exports *patch* (real module already linked by an
 * earlier file's static imports) is reverted at the file boundary. Relying on
 * the module-scope call below therefore breaks under orderings where another
 * file evaluates the real `lib/auth-client` first — which is exactly what
 * happens on CI runners (test-file discovery order is filesystem-dependent).
 */
export function registerAuthMock(): void {
  mock.module(authClientPath, authMockFactory);
}

const authMockFactory = () => ({
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
});

// First-import registration: when a mock-consuming file is the first to
// evaluate this module BEFORE anything linked the real auth-client, this is a
// clean interception. Files still re-register via registerAuthMock() — see
// its doc comment for why the import side effect alone is not enough.
registerAuthMock();
