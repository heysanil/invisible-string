/**
 * Shared better-auth client mock. Importing this module replaces
 * `src/lib/auth-client` for every subsequent import; tests drive behavior
 * through the mutable `authMockState`.
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
export const DEMO_WORKSPACE_ID = "org_demo_1";

export interface MockAuthError {
  message?: string;
  status?: number;
}

export interface MockAuthResult {
  data: unknown;
  error: MockAuthError | null;
}

export const authMockState = {
  session: null as MockSessionData | null,
  pending: false,
  signInResult: { data: null, error: null } as MockAuthResult,
  signUpResult: { data: null, error: null } as MockAuthResult,
  signInCalls: [] as Array<Record<string, unknown>>,
  signUpCalls: [] as Array<Record<string, unknown>>,
};

export function resetAuthMock(): void {
  authMockState.session = null;
  authMockState.pending = false;
  authMockState.signInResult = { data: null, error: null };
  authMockState.signUpResult = { data: null, error: null };
  authMockState.signInCalls = [];
  authMockState.signUpCalls = [];
}

export function demoSession(): MockSessionData {
  return {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: DEMO_WORKSPACE_ID },
  };
}

const authClientPath = new URL("../lib/auth-client.ts", import.meta.url).pathname;

mock.module(authClientPath, () => ({
  authClient: {},
  useSession: () => ({
    data: authMockState.session,
    isPending: authMockState.pending,
    error: null,
    refetch: () => {},
  }),
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
  signOut: async () => ({ data: null, error: null }),
}));
