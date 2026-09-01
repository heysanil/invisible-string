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
 * Every auth request the router gate depends on is bounded.
 *
 * Without this a proxy that ACCEPTS `/get-session` and never answers leaves
 * `beforeLoad`'s promise pending forever: the protected route never commits,
 * and the retry card is unreachable because nothing ever throws. A timeout
 * must surface as UNDETERMINED, never as signed out — and it does, because
 * an aborted request REJECTS (`@better-fetch/fetch` calls `await fetch(...)`
 * with no try/catch), which `call()` below converts to
 * `ViewerUnavailableError`.
 *
 * The signal rides `fetchOptions`, which Better Auth's dynamic-path proxy
 * spreads into the options it hands better-fetch (`dist/client/proxy.mjs`);
 * better-fetch then prefers `opts.signal` over its own controller and passes
 * it straight to `fetch`. Its own `timeout` option is deliberately NOT used:
 * it is cleared the moment response HEADERS arrive, so a body that never
 * completes would still hang.
 */
export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

export interface FetchViewerOptions {
  /** Per-request bound. Tests override it; nothing else should. */
  timeoutMs?: number;
}

interface AuthFetchOptions {
  fetchOptions: { signal: AbortSignal };
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

/**
 * Better Auth resolves most failures as `{error}` but can still reject — and
 * a timeout abort is exactly such a rejection. Both land on the SAME
 * undetermined outcome, which is the point: neither may be read as signed out.
 */
async function call<T>(
  fn: (options: AuthFetchOptions) => Promise<AuthCallResult<T>>,
  timeoutMs: number,
): Promise<AuthCallResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn({ fetchOptions: { signal: controller.signal } });
  } catch {
    throw new ViewerUnavailableError(undefined, "Could not reach the server.");
  } finally {
    clearTimeout(timer);
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

export async function fetchViewer({
  timeoutMs = AUTH_REQUEST_TIMEOUT_MS,
}: FetchViewerOptions = {}): Promise<Viewer | null> {
  const session = await call<SessionShape>(
    (options) =>
      authClient.getSession(options) as Promise<AuthCallResult<SessionShape>>,
    timeoutMs,
  );
  if (session.error) {
    if (isSignedOut(session.error)) return null;
    throw unavailable(session.error);
  }
  if (!session.data?.user) return null;

  const orgs = await call<RawOrganization[]>(
    (options) =>
      authClient.organization.list(options) as Promise<
        AuthCallResult<RawOrganization[]>
      >,
    timeoutMs,
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

/** Who a cached query set belongs to. `null` is a principal too: nobody. */
function principalOf(viewer: Viewer | null): string | null {
  return viewer?.user.id ?? null;
}

/**
 * Drop every non-viewer query when the resolved principal changes.
 *
 * `completeSignIn`/`completeSignOut` only cover a principal change made in
 * THIS tab. Cookies are shared across tabs but QueryClients are not, so when
 * another tab signs Alice out and Bob in, this tab's viewer simply refetches
 * and becomes Bob — while every `["me"]`-scoped entry (`lib/queries/keys.ts`
 * scopes user-level data under a bare `"me"` prefix, identical for every
 * user) still holds Alice's rows. A mounted personal-skill or
 * personal-connection route then renders Alice's data as Bob.
 *
 * This runs INSIDE the query function, before the new viewer is committed to
 * the cache, so no render can ever observe the new principal beside the old
 * principal's data. An effect after the fact is too late by construction.
 *
 * `undefined` (never resolved in this cache) is not a change — there is no
 * previous principal to leak from. A THROW is not a change either: the
 * function never gets here, which is correct, because "couldn't ask" must
 * not evict anything.
 */
function purgeOnPrincipalChange(
  queryClient: QueryClient,
  next: Viewer | null,
): void {
  const cached = queryClient.getQueryData<Viewer | null>(viewerQueryKey);
  if (cached === undefined) return;
  if (principalOf(cached) === principalOf(next)) return;
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== viewerQueryKey[0],
  });
}

export function viewerQueryOptions() {
  return queryOptions({
    queryKey: viewerQueryKey,
    // `client` is the QueryClient (query-core's `queryFnContext`), which is
    // what lets the purge run before this result is committed. The context's
    // `signal` is deliberately NOT consumed: reading it sets query-core's
    // `#abortSignalConsumed`, which cancels an in-flight fetch when the last
    // observer unmounts — and `AppLayout` unmounting mid-gate would then
    // reject `beforeLoad`'s own `fetchQuery`. The bound comes from
    // `AUTH_REQUEST_TIMEOUT_MS` instead.
    queryFn: async ({ client }) => {
      const viewer = await fetchViewer();
      purgeOnPrincipalChange(client, viewer);
      return viewer;
    },
    // Keeps the router gate a cache hit for in-app navigation; without it
    // every route change would issue a /get-session.
    staleTime: 30_000,
    // The gate blocks navigation — fail fast into the retry card rather than
    // doubling time-to-error. Overrides the app default of `retry: 1`.
    retry: false,
    // "always", NOT `true`. `true` refetches only a STALE query
    // (query-core 5.101.2, `shouldFetchOn`: `value === "always" || (value !==
    // false && isStale(...))`), and this query is deliberately fresh for 30 s
    // — so a session revoked in another tab five seconds ago would survive
    // the refocus that is supposed to notice it, and staleness alone never
    // schedules a request. This is the BroadcastChannel sync we gave up by
    // leaving Better Auth's session manager; it has to actually fire.
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
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

/**
 * Select a workspace for a session that has none, then re-read the viewer.
 *
 * Returns `null` for the SAME reason `fetchViewer` does — the session is
 * gone. A 401 here is definitive (the session died between the viewer read
 * and this call), so it must reach the gate as signed-out and redirect to
 * /login; wrapping it as `ActivateWorkspaceError` would show "Can't reach the
 * server" to a user who simply needs to sign in again. A rejected promise is
 * the opposite: transport, never an answer, so it stays undetermined.
 */
export async function activateWorkspace(
  queryClient: QueryClient,
  organizationId: string,
  { timeoutMs = AUTH_REQUEST_TIMEOUT_MS }: FetchViewerOptions = {},
): Promise<Viewer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let result: AuthCallResult<unknown>;
  try {
    result = (await authClient.organization.setActive({
      organizationId,
      fetchOptions: { signal: controller.signal },
    })) as AuthCallResult<unknown>;
  } catch {
    // Includes the timeout abort: bounded, so a hung /set-active can never
    // leave `beforeLoad` pending forever.
    throw new ActivateWorkspaceError("Could not reach the server.");
  } finally {
    clearTimeout(timer);
  }
  if (result.error) {
    if (isSignedOut(result.error)) return null;
    throw new ActivateWorkspaceError(
      result.error.message ?? "Could not select a workspace.",
    );
  }
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
