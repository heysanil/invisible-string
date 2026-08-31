/**
 * The viewer: who is signed in, and which workspaces they have.
 *
 * This module is the SPA's ONLY source of identity. It deliberately does not
 * use Better Auth's React hooks (`useSession`, `useActiveOrganization`,
 * `useListOrganizations`): those are nanostores atoms whose freshness is tied
 * to component mount lifecycle, they report `isPending: false` while holding
 * data they never refetched, and NO signal fires on sign-in — so an atom that
 * resolved while signed out stays 401 for the life of the page. See
 * docs/superpowers/specs/2026-08-31-spa-session-and-workspace-state-design.md.
 *
 * `authClient.getSession()` and `authClient.organization.list()` are plain
 * dynamic-path-proxy calls with no atom, no signal, and no cache, so they
 * always hit the network. That is why they are the right primitives here.
 *
 * THE THREE-WAY CONTRACT, which every consumer must preserve:
 *   resolves `null`  -> definitively signed out      -> redirect to /login
 *   resolves Viewer  -> signed in                    -> render
 *   throws           -> could not determine          -> retry card
 * Collapsing rows 1 and 3 shows a login form to a user whose session is fine,
 * on a form that also cannot reach the server.
 */
import {
  queryOptions,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";

import { authClient, signOut } from "../auth-client";

export interface ViewerWorkspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Viewer {
  user: { id: string; email: string; name: string };
  /** From `session.activeOrganizationId`; null on a fresh signup. */
  activeWorkspaceId: string | null;
  /** Sorted createdAt asc, then id asc — selection must be deterministic. */
  workspaces: ViewerWorkspace[];
}

export const viewerQueryKey = ["viewer"] as const;

/** The session could not be determined (network, 5xx). NOT "signed out". */
export class ViewerUnavailableError extends Error {
  override readonly name = "ViewerUnavailableError";
  constructor(readonly status: number | undefined, message: string) {
    super(message);
  }
}

export class SignOutFailedError extends Error {
  override readonly name = "SignOutFailedError";
}

export class ActivateWorkspaceError extends Error {
  override readonly name = "ActivateWorkspaceError";
}

interface AuthCallError {
  status?: number;
  message?: string;
}

interface AuthCallResult<T> {
  data: T | null;
  error: AuthCallError | null;
}

/**
 * Only 401 means signed out. Every other failure — including a 403 or a
 * status-less transport error — is "undetermined", because logging someone
 * out on an ambiguous answer is the failure mode this whole module exists to
 * prevent.
 */
function isSignedOut(error: AuthCallError): boolean {
  return error.status === 401;
}

function unavailable(error: AuthCallError): ViewerUnavailableError {
  return new ViewerUnavailableError(
    error.status,
    error.message ?? "Could not reach the server.",
  );
}

/** Better Auth resolves most failures as `{error}` but can still reject. */
async function call<T>(fn: () => Promise<AuthCallResult<T>>): Promise<AuthCallResult<T>> {
  try {
    return await fn();
  } catch {
    throw new ViewerUnavailableError(undefined, "Could not reach the server.");
  }
}

/**
 * Better Auth types `createdAt` as a `Date` (organization/client.d.mts) and
 * its JSON parser revives it, so normalize before it escapes into `Viewer` —
 * an interface promising a string must not hand out a Date.
 */
interface RawOrganization {
  id: string;
  name: string;
  slug: string;
  createdAt: string | Date;
}

function toIsoString(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function toWorkspaces(list: RawOrganization[]): ViewerWorkspace[] {
  return list
    .map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: toIsoString(org.createdAt),
    }))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
}

interface SessionShape {
  user: { id: string; email: string; name: string };
  session?: { activeOrganizationId?: string | null } | null;
}

export async function fetchViewer(): Promise<Viewer | null> {
  const session = await call<SessionShape>(
    () => authClient.getSession() as Promise<AuthCallResult<SessionShape>>,
  );
  if (session.error) {
    if (isSignedOut(session.error)) return null;
    throw unavailable(session.error);
  }
  if (!session.data?.user) return null;

  const orgs = await call<RawOrganization[]>(
    () => authClient.organization.list() as Promise<AuthCallResult<RawOrganization[]>>,
  );
  if (orgs.error) {
    // The session was valid a moment ago, so a 401 here means it just died.
    if (isSignedOut(orgs.error)) return null;
    throw unavailable(orgs.error);
  }

  return {
    user: {
      id: session.data.user.id,
      email: session.data.user.email,
      name: session.data.user.name,
    },
    activeWorkspaceId: session.data.session?.activeOrganizationId ?? null,
    workspaces: toWorkspaces(orgs.data ?? []),
  };
}

export function viewerQueryOptions() {
  return queryOptions({
    queryKey: viewerQueryKey,
    queryFn: fetchViewer,
    // Keeps the router gate a cache hit for in-app navigation; without it
    // every route change would issue a /get-session.
    staleTime: 30_000,
    // The gate blocks navigation — fail fast into the retry card rather than
    // doubling time-to-error. Overrides the app default of `retry: 1`.
    retry: false,
    // Overrides the app default of `false`. Load-bearing: this is how a
    // session revoked in another tab is noticed, replacing the BroadcastChannel
    // sync we lose by leaving Better Auth's session manager.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/** The active workspace, or null when there is none (or it is no longer ours). */
export function activeWorkspace(viewer: Viewer): ViewerWorkspace | null {
  if (!viewer.activeWorkspaceId) return null;
  return (
    viewer.workspaces.find((w) => w.id === viewer.activeWorkspaceId) ?? null
  );
}

/** Force a network read and update the cache. The one refresh primitive. */
export function refetchViewer(queryClient: QueryClient): Promise<Viewer | null> {
  return queryClient.fetchQuery({ ...viewerQueryOptions(), staleTime: 0 });
}

/**
 * Called after signIn/signUp succeeds and BEFORE navigating.
 *
 * `clear()` does two jobs: it guarantees the gate reads fresh, and it drops
 * the previous principal's cache. `lib/queries/keys.ts` scopes user-level data
 * under a bare `["me"]` prefix, so without this a second sign-in in the same
 * tab can read the previous account's cached data.
 */
export async function completeSignIn(
  queryClient: QueryClient,
): Promise<Viewer | null> {
  queryClient.clear();
  return refetchViewer(queryClient);
}

/**
 * Better Auth resolves HTTP failures as `{error}` rather than throwing, so an
 * unchecked `await signOut()` navigates to /login with a live session cookie.
 */
export async function completeSignOut(queryClient: QueryClient): Promise<void> {
  const { error } = (await signOut()) as AuthCallResult<unknown>;
  if (error) throw new SignOutFailedError(error.message ?? "Could not sign out.");
  queryClient.clear();
}

export async function activateWorkspace(
  queryClient: QueryClient,
  organizationId: string,
): Promise<Viewer | null> {
  const { error } = (await authClient.organization.setActive({
    organizationId,
  })) as AuthCallResult<unknown>;
  if (error)
    throw new ActivateWorkspaceError(
      error.message ?? "Could not select a workspace.",
    );
  return refetchViewer(queryClient);
}

export interface UseViewerResult {
  viewer: Viewer | null;
  isPending: boolean;
  error: Error | null;
}

export function useViewer(enabled = true): UseViewerResult {
  const query = useQuery({ ...viewerQueryOptions(), enabled });
  return {
    viewer: query.data ?? null,
    isPending: query.isPending,
    error: query.error,
  };
}
