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
  signInResult: ok(),
  signUpResult: ok(),
  signInCalls: [] as Array<Record<string, unknown>>,
  signUpCalls: [] as Array<Record<string, unknown>>,
  /** The session the server hands back when signIn/signUp succeeds. */
  sessionAfterSignIn: null as MockSessionData | null,
  /** Force `organization.list()` to fail with this error (viewer contract tests). */
  listOrganizationsError: null as MockAuthError | null,
  /** Force `getSession()` to fail with this error (viewer contract tests). */
  getSessionError: null as MockAuthError | null,
  listOrganizationsCalls: 0,
  getSessionCalls: 0,
  signOutResult: ok(),
  /**
   * Make a call REJECT instead of resolving `{error}`. `@better-fetch/fetch`
   * does not wrap its `await fetch(...)` in a try/catch, so a real transport
   * failure rejects the proxy promise — this models that half.
   */
  rejectGetSession: false,
  rejectListOrganizations: false,
  rejectSetActive: false,
  /**
   * Hang until the caller's AbortSignal fires — a proxy that accepts the
   * request and never answers. With NO signal the promise never settles,
   * which is precisely the wedge an unbounded auth call produces.
   */
  hangGetSession: false,
  hangListOrganizations: false,
  hangSetActive: false,
  /** The AbortSignal each call was handed, for the bounded-request wiring. */
  getSessionSignals: [] as Array<AbortSignal | undefined>,
  listOrganizationsSignals: [] as Array<AbortSignal | undefined>,
  setActiveSignals: [] as Array<AbortSignal | undefined>,
  /**
   * `setActive` waits on this before it does anything. A mock that mutates
   * synchronously and returns an already-resolved promise cannot tell an
   * AWAITED activation from a fire-and-forget one — both satisfy the same
   * assertions — so the gate test parks activation here on purpose.
   */
  setActiveGate: null as Promise<void> | null,
  /**
   * The session the "server" holds AFTER set-active. `undefined` leaves the
   * normal behaviour alone; `null` models a session that died during
   * activation, and a session whose active organization is still null models
   * an activation that answered 200 without sticking.
   */
  sessionAfterSetActive: undefined as MockSessionData | null | undefined,

  // Organization plugin state
  organizations: [] as MockOrganization[],
  inviteResult: ok(),
  updateMemberRoleResult: ok(),
  updateOrganizationResult: ok(),
  acceptInvitationResult: ok(),
  listInvitationsResult: { data: [], error: null } as MockAuthResult,
  cancelInvitationResult: ok(),
  setActiveResult: ok(),
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
  authMockState.signInResult = ok();
  authMockState.signUpResult = ok();
  authMockState.signInCalls = [];
  authMockState.signUpCalls = [];
  authMockState.sessionAfterSignIn = null;
  authMockState.listOrganizationsError = null;
  authMockState.getSessionError = null;
  authMockState.listOrganizationsCalls = 0;
  authMockState.getSessionCalls = 0;
  authMockState.signOutResult = ok();
  authMockState.rejectGetSession = false;
  authMockState.rejectListOrganizations = false;
  authMockState.rejectSetActive = false;
  authMockState.hangGetSession = false;
  authMockState.hangListOrganizations = false;
  authMockState.hangSetActive = false;
  authMockState.getSessionSignals = [];
  authMockState.listOrganizationsSignals = [];
  authMockState.setActiveSignals = [];
  authMockState.setActiveGate = null;
  authMockState.sessionAfterSetActive = undefined;

  authMockState.organizations = [];
  authMockState.inviteResult = ok();
  authMockState.updateMemberRoleResult = ok();
  authMockState.updateOrganizationResult = ok();
  authMockState.acceptInvitationResult = ok();
  authMockState.listInvitationsResult = { data: [], error: null };
  authMockState.cancelInvitationResult = ok();
  authMockState.setActiveResult = ok();
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

/** Mirror the server: rewrite the session's active organization in place. */
function setSessionActiveOrganization(organizationId: string | null): void {
  if (!authMockState.session) return;
  authMockState.session = {
    ...authMockState.session,
    session: { activeOrganizationId: organizationId },
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
}

/**
 * The AbortSignal the viewer handed this call. Better Auth's dynamic-path
 * proxy spreads `arg.fetchOptions` into the options it passes to
 * `@better-fetch/fetch`, which forwards `signal` straight to `fetch` — so
 * this is where a bounded auth request shows up.
 */
function signalOf(args?: Record<string, unknown>): AbortSignal | undefined {
  const fetchOptions = args?.["fetchOptions"] as
    | { signal?: AbortSignal }
    | undefined;
  return fetchOptions?.signal;
}

/**
 * Never resolves; rejects when the signal aborts. An aborted `fetch` rejects
 * (better-fetch does not catch it), so this is what an abort really looks
 * like to the caller — and with no signal at all, nothing ever settles.
 */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const abort = () => {
      reject(
        Object.assign(new Error("The operation was aborted."), {
          name: "AbortError",
        }),
      );
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

const authClientPath = new URL("../lib/auth-client.ts", import.meta.url).pathname;

/**
 * This mock models the SERVER, not a client cache: `getSession` returns
 * whatever session the "server" holds, `organization.list` 401s without one,
 * and signIn/signUp establish a session the way the real endpoints do. The
 * previous version hand-wrote reactive hooks and was, as a result, strictly
 * more correct than the library it replaced — which is why the suite could
 * never fail on the double-login bug.
 */
const organizationMock = {
  setActive: async (args: Record<string, unknown>) => {
    authMockState.setActiveCalls.push(args);
    authMockState.setActiveSignals.push(signalOf(args));
    if (authMockState.hangSetActive) return hangUntilAborted(signalOf(args));
    if (authMockState.rejectSetActive) throw new Error("network");
    if (authMockState.setActiveGate) await authMockState.setActiveGate;
    const result = authMockState.setActiveResult;
    if (result.error) return result;
    const id = (args["organizationId"] as string | null) ?? null;
    if (!id) {
      setSessionActiveOrganization(null);
      return result;
    }
    let org = authMockState.organizations.find((candidate) => candidate.id === id);
    if (!org) {
      // Unknown id: mirror the real client, which fetches this org fresh
      // from the server even when the (stale) list doesn't have it yet,
      // e.g. right after accepting an invitation.
      org = { id, name: id, slug: id, createdAt: "2026-07-08T00:00:00.000Z" };
      authMockState.organizations = [...authMockState.organizations, org];
    }
    setSessionActiveOrganization(id);
    if (authMockState.sessionAfterSetActive !== undefined) {
      authMockState.session = authMockState.sessionAfterSetActive;
    }
    return result;
  },
  create: async (args: Record<string, unknown>) => {
    authMockState.createOrganizationCalls.push(args);
    const result = authMockState.createOrganizationResult;
    if (!result.error && result.data) {
      const org = result.data as MockOrganization;
      authMockState.organizations = [...authMockState.organizations, org];
      // Better Auth activates a newly created organization server-side
      // (crud-org.mjs), which is why the client sends no setActive.
      setSessionActiveOrganization(org.id);
    }
    return result;
  },
  list: async (args?: Record<string, unknown>): Promise<MockAuthResult> => {
    authMockState.listOrganizationsCalls++;
    authMockState.listOrganizationsSignals.push(signalOf(args));
    if (authMockState.hangListOrganizations)
      return hangUntilAborted(signalOf(args));
    if (authMockState.rejectListOrganizations) throw new Error("network");
    if (authMockState.listOrganizationsError)
      return { data: null, error: authMockState.listOrganizationsError };
    // The real endpoint requires a session: no session means 401, which the
    // viewer reads as "signed out". Modelling this is the whole point — the
    // old mock returned data regardless and could never reproduce the bug.
    if (!authMockState.session)
      return { data: null, error: { status: 401, message: "UNAUTHORIZED" } };
    return { data: authMockState.organizations, error: null };
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
    const result = authMockState.updateOrganizationResult;
    if (!result.error) {
      const id = args["organizationId"] as string;
      const name = (args["data"] as { name?: string } | undefined)?.name;
      if (name) {
        authMockState.organizations = authMockState.organizations.map((org) =>
          org.id === id ? { ...org, name } : org,
        );
      }
    }
    return result;
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
  authClient: {
    getSession: async (
      args?: Record<string, unknown>,
    ): Promise<MockAuthResult> => {
      authMockState.getSessionCalls++;
      authMockState.getSessionSignals.push(signalOf(args));
      if (authMockState.hangGetSession) return hangUntilAborted(signalOf(args));
      if (authMockState.rejectGetSession) throw new Error("network");
      if (authMockState.getSessionError)
        return { data: null, error: authMockState.getSessionError };
      return { data: authMockState.session, error: null };
    },
    organization: organizationMock,
  },
  signIn: {
    email: async (args: Record<string, unknown>) => {
      authMockState.signInCalls.push(args);
      const result = authMockState.signInResult;
      if (!result.error && authMockState.sessionAfterSignIn)
        authMockState.session = authMockState.sessionAfterSignIn;
      return result;
    },
  },
  signUp: {
    email: async (args: Record<string, unknown>) => {
      authMockState.signUpCalls.push(args);
      const result = authMockState.signUpResult;
      if (!result.error && authMockState.sessionAfterSignIn)
        authMockState.session = authMockState.sessionAfterSignIn;
      return result;
    },
  },
  signOut: async () => authMockState.signOutResult,
});

// First-import registration: when a mock-consuming file is the first to
// evaluate this module BEFORE anything linked the real auth-client, this is a
// clean interception. Files still re-register via registerAuthMock() — see
// its doc comment for why the import side effect alone is not enough.
registerAuthMock();
