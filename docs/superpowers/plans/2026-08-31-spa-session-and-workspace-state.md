# SPA Session + Workspace State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make signing in work on the first attempt and render workspace content immediately, by moving the SPA's identity state off Better Auth's nanostores atoms into a TanStack Query `viewer` query gated in the router.

**Architecture:** One `viewer` query owns `{user, activeWorkspaceId, workspaces}`, fetched through Better Auth's plain proxy calls (`authClient.getSession()`, `authClient.organization.list()`) which carry no cache. `_app` gates in an async `beforeLoad` that `throw redirect(...)`s, so no render ever decides authentication from a stale snapshot. Better Auth keeps every mutation; nothing reads through its React hooks.

**Tech Stack:** React 19 · TanStack Router 1.170.17 · TanStack Query 5.101.2 · better-auth 1.6.23 · Bun test + happy-dom + Testing Library · Playwright (e2e)

**Spec:** `docs/superpowers/specs/2026-08-31-spa-session-and-workspace-state-design.md`

## Global Constraints

- **Never import a Better Auth React hook in `apps/web`.** `useSession`, `useActiveOrganization`, `useListOrganizations` are banned; Task 9 removes the exports.
- **`apps/control-plane` is not modified.** No schema change, no migration, no `COMPILER_VERSION` bump, no `BUILD_ENV_EPOCH` bump.
- **"Signed out" and "could not ask" stay distinct** end to end: `null` means signed out, a thrown `ViewerUnavailableError` means undetermined. Never redirect to `/login` on a thrown error.
- **`fetchQuery`, never `ensureQueryData`** for the gate — `ensureQueryData` returns stale cached data without revalidating unless `revalidateIfStale` is set (`@tanstack/query-core@5.101.2`).
- **E1 design system is law**: reuse `components/ui` primitives and `components/auth/AuthCard`; no one-off styles. Colour only as meaning.
- **TypeScript strict.** Run `bun run --cwd apps/web typecheck` before every commit.
- **Commit messages never mention AI assistance.** Conventional commits (`fix(web): …`, `test(web): …`, `docs: …`).
- Test command for this plan: `bun test apps/web` from the repo root (DOM suites self-register happy-dom).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/lib/query-client.ts` | **new** — `createAppQueryClient()` factory. One place the client defaults are spelled. |
| `apps/web/src/lib/auth/viewer.ts` | **new** — the viewer type, its query, and every principal transition (`completeSignIn`, `completeSignOut`, `activateWorkspace`, `refetchViewer`). |
| `apps/web/src/components/auth/SessionUnavailableScreen.tsx` | **new** — the retry card for an undetermined session. |
| `apps/web/src/routes/__root.tsx` | Typed router context; renders `QueryClientProvider` from the context's client. |
| `apps/web/src/main.tsx` | Creates the client, passes it as router context. |
| `apps/web/src/routes/_app.tsx` | The gate (`beforeLoad`), `errorComponent`, and a slimmed `AppLayout`. |
| `apps/web/src/routes/login.tsx`, `signup.tsx` | `completeSignIn` before navigating. |
| `apps/web/src/lib/workspace.ts` | Workspace + role hooks, rebuilt on the viewer. No activation effect. |
| `apps/web/src/components/WorkspaceGate.tsx` | Adds an error state distinct from the empty state. |
| `apps/web/src/components/onboarding/CreateWorkspaceScreen.tsx` | Single create call + viewer refetch; honest failure copy. |
| `apps/web/src/components/settings/WorkspacePanel.tsx` | `completeSignOut`; viewer refetch after rename. |
| `apps/web/src/routes/accept-invitation.$invitationId.tsx` | Viewer query replaces the bespoke session probe. |
| `apps/web/src/routes/_app.settings.members.tsx` | `useViewer()` for the current user id. |
| `apps/web/src/lib/auth-client.ts` | Stops exporting the three hooks (Task 9). |
| `apps/web/src/test/auth-mock.ts` | Models the **server**, not a client cache. |
| `apps/web/src/__tests__/viewer-query.test.ts` | **new** — the three-way contract. |
| `apps/web/src/__tests__/auth-flow.test.tsx` | **new** — the ordering regression test. |
| `e2e/specs/auth-flow.e2e.ts` | **new** — sign in without a prior `page.goto("/login")`. |

---

## Task 1: The viewer query

**Files:**
- Create: `apps/web/src/lib/query-client.ts`
- Create: `apps/web/src/lib/auth/viewer.ts`
- Modify: `apps/web/src/test/auth-mock.ts`
- Test: `apps/web/src/__tests__/viewer-query.test.ts`

**Interfaces:**
- Consumes: `authClient`, `signOut` from `apps/web/src/lib/auth-client.ts`.
- Produces:
  - `createAppQueryClient(): QueryClient`
  - `interface ViewerWorkspace { id: string; name: string; slug: string; createdAt: string }`
  - `interface Viewer { user: { id: string; email: string; name: string }; activeWorkspaceId: string | null; workspaces: ViewerWorkspace[] }`
  - `const viewerQueryKey: readonly ["viewer"]`
  - `class ViewerUnavailableError extends Error`
  - `class SignOutFailedError extends Error`
  - `class ActivateWorkspaceError extends Error`
  - `fetchViewer(): Promise<Viewer | null>`
  - `viewerQueryOptions()` → TanStack `queryOptions` for the viewer
  - `activeWorkspace(viewer: Viewer): ViewerWorkspace | null`
  - `refetchViewer(qc: QueryClient): Promise<Viewer | null>`
  - `completeSignIn(qc: QueryClient): Promise<Viewer | null>`
  - `completeSignOut(qc: QueryClient): Promise<void>`
  - `activateWorkspace(qc: QueryClient, organizationId: string): Promise<Viewer | null>`
  - `useViewer(enabled?: boolean): { viewer: Viewer | null; isPending: boolean; error: Error | null }`

- [ ] **Step 1: Teach the auth mock to model the server**

The mock currently hand-writes reactive hooks (`useSyncExternalStore`, `notifyOrgStore`) and its mutations update only that *atom-shaped* state. Leave the hooks in place for now — Tasks 2–7 still consume them — but add the two async calls the viewer query makes, make `signIn`/`signUp` establish a session, and make **every successful mutation update the server-shaped state too** (`authMockState.session.session.activeOrganizationId` and `authMockState.organizations`).

That last part is not optional bookkeeping. The viewer reads *only* `session.activeOrganizationId` and `organization.list()`, so a mock whose `setActive` updates only `activeOrganization` would let later tests assert that `setActive` was *called* while the viewer never actually becomes active — a test that passes without proving anything.

In `apps/web/src/test/auth-mock.ts`, add to `authMockState`:

```ts
  /** The session the server hands back when signIn/signUp succeeds. */
  sessionAfterSignIn: null as MockSessionData | null,
  /** Force `organization.list()` to fail with this error (viewer contract tests). */
  listOrganizationsError: null as MockAuthError | null,
  /** Force `getSession()` to fail with this error (viewer contract tests). */
  getSessionError: null as MockAuthError | null,
  listOrganizationsCalls: 0,
  getSessionCalls: 0,
  signOutResult: ok(),
```

Reset them in `resetAuthMock()`:

```ts
  authMockState.sessionAfterSignIn = null;
  authMockState.listOrganizationsError = null;
  authMockState.getSessionError = null;
  authMockState.listOrganizationsCalls = 0;
  authMockState.getSessionCalls = 0;
  authMockState.signOutResult = ok();
```

Add a helper next to `demoSession()` so mutations can rewrite the session's active workspace without losing the user:

```ts
/** Mirror the server: rewrite the session's active organization in place. */
function setSessionActiveOrganization(organizationId: string | null): void {
  if (!authMockState.session) return;
  authMockState.session = {
    ...authMockState.session,
    session: { activeOrganizationId: organizationId },
  };
}
```

Add `list` to `organizationMock` (place it beside `setActive`):

```ts
  list: async (): Promise<MockAuthResult> => {
    authMockState.listOrganizationsCalls++;
    if (authMockState.listOrganizationsError)
      return { data: null, error: authMockState.listOrganizationsError };
    // The real endpoint requires a session: no session means 401, which the
    // viewer reads as "signed out". Modelling this is the whole point — the
    // old mock returned data regardless and could never reproduce the bug.
    if (!authMockState.session)
      return { data: null, error: { status: 401, message: "UNAUTHORIZED" } };
    return { data: authMockState.organizations, error: null };
  },
```

Replace `authClient.getSession` in `authMockFactory` with:

```ts
    getSession: async (): Promise<MockAuthResult> => {
      authMockState.getSessionCalls++;
      if (authMockState.getSessionError)
        return { data: null, error: authMockState.getSessionError };
      return { data: authMockState.session, error: null };
    },
```

And make the credential calls establish the session, as the server does:

```ts
  signIn: {
    email: async (args: Record<string, unknown>) => {
      authMockState.signInCalls.push(args);
      const result = authMockState.signInResult;
      if (!result.error && authMockState.sessionAfterSignIn)
        authMockState.session = authMockState.sessionAfterSignIn;
      return result;
    },
  },
```

Apply the same three added lines to `signUp.email`. Also make `signOut` return the new state field:

```ts
  signOut: async () => authMockState.signOutResult,
```

- [ ] **Step 1b: Make the mutations update server-shaped state**

Still in `apps/web/src/test/auth-mock.ts`. Keep every existing `notifyOrgStore()` call and the `activeOrganization` writes — the old hooks are still live until Task 8 — and **add** the server-shaped updates beside them.

`setActive` — activate on the session, and learn organizations the client list did not know about (exactly what happens right after accepting an invitation):

```ts
  setActive: async (args: Record<string, unknown>) => {
    authMockState.setActiveCalls.push(args);
    const result = authMockState.setActiveResult;
    if (result.error) return result;
    const id = (args["organizationId"] as string | null) ?? null;
    if (!id) {
      authMockState.activeOrganization = null;
      setSessionActiveOrganization(null);
      notifyOrgStore();
      return result;
    }
    let org = authMockState.organizations.find((candidate) => candidate.id === id);
    if (!org) {
      org = { id, name: id, slug: id, createdAt: "2026-07-08T00:00:00.000Z" };
      authMockState.organizations = [...authMockState.organizations, org];
    }
    authMockState.activeOrganization = org;
    setSessionActiveOrganization(id);
    notifyOrgStore();
    return result;
  },
```

`create` — the real `/organization/create` activates the new organization server-side, so the mock must too:

```ts
  create: async (args: Record<string, unknown>) => {
    authMockState.createOrganizationCalls.push(args);
    const result = authMockState.createOrganizationResult;
    if (!result.error && result.data) {
      const org = result.data as MockOrganization;
      authMockState.organizations = [...authMockState.organizations, org];
      // Better Auth activates a newly created organization server-side
      // (crud-org.mjs), which is why the client sends no setActive.
      authMockState.activeOrganization = org;
      setSessionActiveOrganization(org.id);
      notifyOrgStore();
    }
    return result;
  },
```

`update` — a rename must actually rename, or the "name updates live" test proves nothing:

```ts
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
        if (authMockState.activeOrganization?.id === id)
          authMockState.activeOrganization = {
            ...authMockState.activeOrganization,
            name,
          };
        notifyOrgStore();
      }
    }
    return result;
  },
```

Accepting an invitation needs no change here: `accept-invitation` follows a successful accept with `setActive`, and the `setActive` above now adds the unknown organization to the list.

Note the deliberate divergence from the previous mock's comment about *not* notifying on `create`: it existed to stop `useWorkspace`'s fire-and-forget self-heal from firing a duplicate `setActive`. That self-heal is deleted in Task 5, so the hazard is gone.

- [ ] **Step 2: Write the failing contract test**

Create `apps/web/src/__tests__/viewer-query.test.ts`:

```ts
import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { beforeEach, expect, test } from "bun:test";

import {
  authMockState,
  demoSession,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";

ensureDomForThisFile();
registerAuthMock();

const { fetchViewer, activeWorkspace, ViewerUnavailableError } = await import(
  "../lib/auth/viewer"
);

beforeEach(resetAuthMock);

test("a null session resolves to null — definitively signed out", async () => {
  authMockState.session = null;
  expect(await fetchViewer()).toBeNull();
});

test("a 401 on the session call resolves to null, not an error", async () => {
  authMockState.getSessionError = { status: 401, message: "UNAUTHORIZED" };
  expect(await fetchViewer()).toBeNull();
});

test("a 401 on the org list resolves to null — the session died mid-flight", async () => {
  authMockState.session = demoSession();
  authMockState.listOrganizationsError = { status: 401, message: "UNAUTHORIZED" };
  expect(await fetchViewer()).toBeNull();
});

test("a 5xx throws rather than resolving to null", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  await expect(fetchViewer()).rejects.toBeInstanceOf(ViewerUnavailableError);
});

test("a transport failure with no status throws", async () => {
  authMockState.getSessionError = { message: "network" };
  await expect(fetchViewer()).rejects.toBeInstanceOf(ViewerUnavailableError);
});

test("a signed-in viewer carries the user, active id, and sorted workspaces", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [
    { id: "org_b", name: "Beta", slug: "beta", createdAt: "2026-07-09T00:00:00.000Z" },
    demoWorkspace(), // org_test_1, createdAt 2026-07-01
  ];
  const viewer = await fetchViewer();
  expect(viewer?.user.id).toBe("u1");
  expect(viewer?.activeWorkspaceId).toBe("org_test_1");
  expect(viewer?.workspaces.map((w) => w.id)).toEqual(["org_test_1", "org_b"]);
});

test("activeWorkspace resolves the active id against the list", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  const viewer = await fetchViewer();
  expect(activeWorkspace(viewer!)?.name).toBe("Acme");
});

test("activeWorkspace is null when the active id is not a workspace the user has", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: "org_gone" },
  };
  authMockState.organizations = [demoWorkspace()];
  const viewer = await fetchViewer();
  expect(activeWorkspace(viewer!)).toBeNull();
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `bun test apps/web/src/__tests__/viewer-query.test.ts`
Expected: FAIL — cannot resolve `../lib/auth/viewer`.

- [ ] **Step 4: Create the query client factory**

Create `apps/web/src/lib/query-client.ts`:

```ts
/**
 * The app's TanStack Query client. A factory rather than a module singleton
 * so tests get an isolated cache per render — a shared client would leak
 * one test's viewer into the next.
 *
 * `refetchOnWindowFocus: false` is the app-wide default because product
 * resources are workspace-scoped and rarely change under the user. The
 * viewer query deliberately overrides it (lib/auth/viewer.ts): focus is how
 * a session revoked or signed out in another tab gets noticed.
 */
import { QueryClient } from "@tanstack/react-query";

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });
}
```

- [ ] **Step 5: Create the viewer module**

Create `apps/web/src/lib/auth/viewer.ts`:

```ts
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
```

- [ ] **Step 6: Run the contract test**

Run: `bun test apps/web/src/__tests__/viewer-query.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Confirm nothing else broke**

Run: `bun run --cwd apps/web typecheck && bun test apps/web`
Expected: typecheck clean, whole web suite green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/query-client.ts apps/web/src/lib/auth/viewer.ts \
        apps/web/src/test/auth-mock.ts apps/web/src/__tests__/viewer-query.test.ts
git commit -m "feat(web): add the viewer query as the SPA's identity source"
```

---

## Task 2: Router context

**Files:**
- Modify: `apps/web/src/routes/__root.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/__tests__/login.test.tsx`, `shell.test.tsx`, `create-workspace.test.tsx`, `accept-invitation.test.tsx` (router factories only)

**Interfaces:**
- Consumes: `createAppQueryClient` (Task 1).
- Produces: router context type `{ queryClient: QueryClient }`, available to every route's `beforeLoad` as `context.queryClient`.

- [ ] **Step 1: Type the root route's context**

Replace `apps/web/src/routes/__root.tsx` with:

```tsx
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import { ToastProvider } from "../components/ui/Toast";
import { Wash } from "../components/Wash";

/**
 * Router context. The QueryClient lives here (rather than as a module
 * singleton) so route `beforeLoad` guards can read and write the cache — the
 * auth gate in routes/_app.tsx resolves the viewer before the route commits.
 */
export interface AppRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Wash />
        <Outlet />
      </ToastProvider>
    </QueryClientProvider>
  );
}
```

`Route.useRouteContext()` is defined directly on `RootRoute`
(@tanstack/react-router `src/route.tsx:542`) and returns the root match's
accumulated context, so this is the supported read — no fallback needed.

- [ ] **Step 2: Pass the context at router creation**

In `apps/web/src/main.tsx`, replace the `createRouter` call:

```tsx
import { createAppQueryClient } from "./lib/query-client";

const queryClient = createAppQueryClient();

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  context: { queryClient },
});
```

- [ ] **Step 3: Give every test router a context**

Each of the four test files has a `createRouter({ routeTree, history })` call. Add the context and a fresh client per render. In `login.test.tsx`, `shell.test.tsx`, `create-workspace.test.tsx`, and `accept-invitation.test.tsx`, add the import:

```ts
import { createAppQueryClient } from "../lib/query-client";
```

and change each router factory to:

```ts
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: createAppQueryClient() },
  });
```

A fresh client per render matters: a shared one would carry one test's viewer into the next.

- [ ] **Step 4: Verify**

Run: `bun run --cwd apps/web typecheck && bun test apps/web`
Expected: typecheck clean (a missing `context` is now a type error), suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/__root.tsx apps/web/src/main.tsx \
        apps/web/src/__tests__/login.test.tsx \
        apps/web/src/__tests__/shell.test.tsx \
        apps/web/src/__tests__/create-workspace.test.tsx \
        apps/web/src/__tests__/accept-invitation.test.tsx
git commit -m "refactor(web): put the query client in router context"
```

---

## Task 3: The auth gate

**Files:**
- Create: `apps/web/src/components/auth/SessionUnavailableScreen.tsx`
- Modify: `apps/web/src/routes/_app.tsx`
- Test: `apps/web/src/__tests__/auth-gate.test.tsx` (new)

**Interfaces:**
- Consumes: `viewerQueryOptions`, `activeWorkspace`, `activateWorkspace`, `useViewer`, `viewerQueryKey` (Task 1); `AppRouterContext` (Task 2).
- Produces: `_app` guarantees that whatever renders below it has a signed-in viewer.

- [ ] **Step 1: Write the failing gate test**

Create `apps/web/src/__tests__/auth-gate.test.tsx`:

```tsx
import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import {
  authMockState,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
  signInToDemoWorkspace,
} from "../test/auth-mock";
import { installFetchMock, type FetchMock } from "../test/harness";
import { createAppQueryClient } from "../lib/query-client";

ensureDomForThisFile();
registerAuthMock();

const { routeTree } = await import("../routeTree.gen");

function renderApp(path = "/chat") {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: createAppQueryClient() },
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
});
afterEach(() => {
  cleanup();
  fetchMock.restore();
});

test("a signed-out visitor to a protected route lands on /login", async () => {
  authMockState.session = null;
  const { router } = renderApp("/chat");
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
});

test("an undetermined session shows the retry card, never the login form", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const { router, view } = renderApp("/chat");
  expect(await view.findByText("Can't reach the server")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/chat");
});

test("a signed-in viewer with no workspace gets first-run onboarding", async () => {
  authMockState.session = {
    user: { id: "u_new", email: "new@example.com", name: "New User" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [];
  const { view } = renderApp("/chat");
  expect(await view.findByText("Create your workspace")).toBeTruthy();
});

test("a signed-in viewer with an unset active workspace has one selected for them", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [demoWorkspace()];
  const { view } = renderApp("/chat");
  // Assert the OUTCOME, not the call: the shell renders, which it only can
  // once the session actually carries an active workspace.
  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
  expect(authMockState.setActiveCalls).toContainEqual({
    organizationId: "org_test_1",
  });
  expect(authMockState.session?.session?.activeOrganizationId).toBe("org_test_1");
});

test("a fully signed-in viewer renders the shell", async () => {
  signInToDemoWorkspace();
  // A positive assertion, never `queryBy…` to be null — an absent element is
  // also absent mid-transition, so a negative-only assertion passes vacuously.
  const { view } = renderApp("/chat");
  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test apps/web/src/__tests__/auth-gate.test.tsx`
Expected: FAIL — the retry-card test fails (today the app redirects to `/login` on an unreachable API).

- [ ] **Step 3: Build the retry card**

Create `apps/web/src/components/auth/SessionUnavailableScreen.tsx`:

```tsx
import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { viewerQueryKey } from "../../lib/auth/viewer";
import { Button } from "../ui/Button";
import { AuthCard } from "./AuthCard";

/**
 * Shown when the session could NOT be determined — a network failure or a
 * 5xx, never a 401. A user whose session is fine must not be handed a login
 * form served by a server that cannot answer it.
 *
 * Do NOT call the `reset` prop. `ErrorComponentProps` declares it, but for an
 * error thrown from `beforeLoad`/`loader` the router passes
 * `reset={undefined as any}` (@tanstack/react-router `src/Match.tsx:382`), so
 * calling it throws a TypeError. `router.invalidate()` is the supported
 * recovery: it resets errored matches to pending and reloads them.
 */
export function SessionUnavailableScreen() {
  const queryClient = useQueryClient();
  const router = useRouter();

  function retry() {
    queryClient.removeQueries({ queryKey: viewerQueryKey });
    void router.invalidate();
  }

  return (
    <AuthCard
      title="Can't reach the server"
      subtitle="Check your connection, then try again"
    >
      <Button className="w-full" onClick={retry}>
        Try again
      </Button>
    </AuthCard>
  );
}
```

- [ ] **Step 4: Rewrite the gate**

Replace `apps/web/src/routes/_app.tsx` with:

```tsx
import {
  createFileRoute,
  Navigate,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppShell } from "../components/AppShell";
import { SessionUnavailableScreen } from "../components/auth/SessionUnavailableScreen";
import { CreateWorkspaceScreen } from "../components/onboarding/CreateWorkspaceScreen";
import { Spinner } from "../components/ui/Spinner";
import { FIXTURE_MODE } from "../lib/chat/fixtures";
import {
  activateWorkspace,
  activeWorkspace,
  useViewer,
  viewerQueryOptions,
} from "../lib/auth/viewer";

/**
 * The authenticated shell.
 *
 * The auth decision happens HERE, in `beforeLoad`, and never in render. A
 * render-time gate is what produced the double-login bug: it read a Better
 * Auth atom that reported `isPending: false` over a resolved-null snapshot
 * captured before the user signed in, and bounced them straight back to
 * /login. `throw redirect(...)` is atomic with navigation resolution, so no
 * render can observe a half-resolved session at all.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location, cause }) => {
    // Preloading must never decide authentication. `beforeLoad` runs again
    // for the real navigation (router-core `load-matches.ts`), so returning
    // here cannot let an actual navigation bypass the guard. Note this returns
    // BEFORE fetching, so a preload warms nothing — and any future loader on a
    // descendant route would therefore run during preload with no viewer in
    // context. Add one only if it tolerates that.
    if (cause === "preload") return;
    // Fixture mode is a backendless design/E2E harness — there is no session.
    if (FIXTURE_MODE) return;

    // fetchQuery, not ensureQueryData: ensureQueryData returns stale cached
    // data without revalidating, which would let the gate authorize from a
    // stale cache — the same defect in a different library.
    const viewer = await context.queryClient.fetchQuery(viewerQueryOptions());

    if (!viewer) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
        replace: true,
      });
    }

    // A fresh login (or an invite acceptance) can leave the session with no
    // active organization. Activation is AWAITED here so its failure is an
    // error the user can see and retry, rather than the fire-and-forget
    // effect that used to leave useWorkspace() pending forever.
    if (activeWorkspace(viewer) === null && viewer.workspaces.length > 0) {
      await activateWorkspace(context.queryClient, viewer.workspaces[0]!.id);
    }
  },
  errorComponent: SessionUnavailableScreen,
  component: AppLayout,
});

function AppLayout() {
  // Kept mounted so a focus refetch that resolves null (session revoked or
  // signed out in another tab) leaves the shell instead of stranding it.
  const { viewer, isPending } = useViewer(!FIXTURE_MODE);

  if (FIXTURE_MODE) {
    return (
      <AppShell>
        <Outlet />
      </AppShell>
    );
  }

  if (isPending) {
    return (
      <div
        role="status"
        aria-label="Loading"
        className="flex min-h-dvh items-center justify-center"
      >
        <Spinner size={20} className="text-ink-4" />
      </div>
    );
  }

  if (!viewer) return <Navigate to="/login" replace />;
  if (viewer.workspaces.length === 0) return <CreateWorkspaceScreen />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
```

- [ ] **Step 5: Run the gate test**

Run: `bun test apps/web/src/__tests__/auth-gate.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Verify the rest**

Run: `bun run --cwd apps/web typecheck && bun test apps/web`
Expected: typecheck clean, suite green. `lib/workspace.ts` still uses the old hooks at this point — that is expected and fixed in Task 5.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/_app.tsx \
        apps/web/src/components/auth/SessionUnavailableScreen.tsx \
        apps/web/src/__tests__/auth-gate.test.tsx
git commit -m "fix(web): gate the app shell in beforeLoad instead of in render"
```

---

## Task 4: Sign-in and sign-up — the regression test

**Files:**
- Modify: `apps/web/src/routes/login.tsx:70-90`
- Modify: `apps/web/src/routes/signup.tsx:83-105`
- Test: `apps/web/src/__tests__/auth-flow.test.tsx` (new)

**Interfaces:**
- Consumes: `completeSignIn` (Task 1), the gate (Task 3).
- Produces: after a successful credential call, the viewer cache is authoritative **before** navigation begins.

- [ ] **Step 1: Write the failing regression test**

This is the test that reproduces the reported bug. It must exercise **one continuous app lifetime**: boot signed out at a protected route, get redirected, sign in once, and land in the shell. A test that starts at `/login`, or that recreates the router between steps, destroys the precondition and proves nothing.

Create `apps/web/src/__tests__/auth-flow.test.tsx`:

```tsx
import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import {
  authMockState,
  demoSession,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";
import { installFetchMock, type FetchMock } from "../test/harness";
import { createAppQueryClient } from "../lib/query-client";

ensureDomForThisFile();
registerAuthMock();

const { routeTree } = await import("../routeTree.gen");

function renderApp(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: createAppQueryClient() },
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

function submitLogin(view: RenderResult, email: string, password: string) {
  fireEvent.change(view.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(view.getByLabelText("Password"), {
    target: { value: password },
  });
  const button = view.getByRole("button", { name: /sign in/i });
  const form = button.closest("form");
  if (!form) throw new Error("login form not found");
  fireEvent.submit(form);
}

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
});
afterEach(() => {
  cleanup();
  fetchMock.restore();
});

/**
 * The reported bug, end to end: boot signed out, get bounced to /login, sign
 * in ONCE, and land in the shell. Against the pre-fix code the app bounced
 * back to /login here, which is why users had to type their password twice.
 */
test("signing in once, after a signed-out boot, lands in the shell", async () => {
  authMockState.session = null;
  authMockState.organizations = [demoWorkspace()];
  authMockState.sessionAfterSignIn = demoSession();

  const { router, view } = renderApp("/chat");

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
  await view.findByText("Welcome back");

  submitLogin(view, "demo@example.com", "hunter2hunter2");

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/chat");
  });
  expect(authMockState.signInCalls).toHaveLength(1);
});

/** The second symptom: workspace content must be there without a reload. */
test("workspace content resolves immediately after that single sign-in", async () => {
  authMockState.session = null;
  authMockState.organizations = [demoWorkspace()];
  authMockState.sessionAfterSignIn = demoSession();

  const { view } = renderApp("/chat");
  await view.findByText("Welcome back");
  submitLogin(view, "demo@example.com", "hunter2hunter2");

  // Positive assertion first: waiting only for elements to be ABSENT would
  // also pass during the blank frame between the form and the shell.
  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
  expect(view.queryByText("No workspace yet")).toBeNull();
  expect(view.queryByText("Welcome back")).toBeNull();
});

test("a deep link is preserved across the sign-in bounce", async () => {
  authMockState.session = null;
  authMockState.organizations = [demoWorkspace()];
  authMockState.sessionAfterSignIn = demoSession();

  const { router, view } = renderApp("/settings/members");
  await view.findByText("Welcome back");
  submitLogin(view, "demo@example.com", "hunter2hunter2");

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/settings/members");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test apps/web/src/__tests__/auth-flow.test.tsx`
Expected: FAIL — after submit the app stays on `/login`, because `login.tsx` navigates before the viewer cache knows about the new session.

- [ ] **Step 3: Make login authoritative before navigating**

In `apps/web/src/routes/login.tsx`, add the imports:

```ts
import { useQueryClient } from "@tanstack/react-query";
import { completeSignIn } from "../lib/auth/viewer";
```

Inside `LoginPage`, add `const queryClient = useQueryClient();` beside the other hooks, and replace the success branch of `handleSubmit`:

```ts
      const { error } = await signIn.email({ email: email.trim(), password });
      if (!error) {
        // Read the session authoritatively BEFORE navigating. Better Auth
        // defers its own session signal by 10ms, so navigating first is how
        // the gate used to see a pre-login snapshot and bounce back here.
        // This also clears the previous principal's query cache.
        await completeSignIn(queryClient);
        // `redirect` is pre-validated to a same-app path; history.push keeps
        // the typed router happy with a runtime-known destination.
        if (redirect) router.history.push(redirect);
        else await navigate({ to: "/chat" });
      } else if (!error.status || error.status >= 500) {
```

`completeSignIn` throws on a transport failure, which the existing outer `catch` already turns into `connectionFailed()` — the user stays on a page that can explain itself.

- [ ] **Step 4: Do the same for signup**

In `apps/web/src/routes/signup.tsx`, add the same two imports and `const queryClient = useQueryClient();`, then replace its success branch:

```ts
      if (!error) {
        await completeSignIn(queryClient);
        if (redirect) router.history.push(redirect);
        else await navigate({ to: "/chat" });
      } else if (!error.status || error.status >= 500) {
```

- [ ] **Step 5: Run the regression test**

Run: `bun test apps/web/src/__tests__/auth-flow.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Verify**

Run: `bun run --cwd apps/web typecheck && bun test apps/web`
Expected: typecheck clean, suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/login.tsx apps/web/src/routes/signup.tsx \
        apps/web/src/__tests__/auth-flow.test.tsx
git commit -m "fix(web): resolve the session before navigating out of sign-in"
```

---

## Task 5: Workspace hooks and the gate's error state

**Files:**
- Modify: `apps/web/src/lib/workspace.ts` (full rewrite)
- Modify: `apps/web/src/components/WorkspaceGate.tsx`
- Modify: `apps/web/src/routes/_app.settings.members.tsx`
- Test: `apps/web/src/__tests__/workspace-gate.test.tsx` (new)

**Interfaces:**
- Consumes: `useViewer`, `activeWorkspace`, `Viewer` (Task 1).
- Produces (unchanged names, new internals):
  - `useWorkspace(): { workspace: ActiveWorkspace | null; isPending: boolean; error: Error | null }`
  - `useActiveWorkspaceId(): { workspaceId: string | null; isPending: boolean }`
  - `useWorkspaceRole(workspaceId: string | undefined): UseWorkspaceRoleResult`
  - `WorkspaceContext` gains no fields; `WorkspaceGate` gains an error branch.

- [ ] **Step 1: Write the failing gate test**

Create `apps/web/src/__tests__/workspace-gate.test.tsx`:

```tsx
import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";

import {
  authMockState,
  demoSession,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";
import {
  installFetchMock,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";

ensureDomForThisFile();
registerAuthMock();

const { WorkspaceGate } = await import("../components/WorkspaceGate");

// renderWithProviders already supplies an isolated QueryClient and the
// ToastProvider (test/harness.tsx) — do not hand-roll another one.
function renderGate() {
  return renderWithProviders(
    <WorkspaceGate title="Members">
      {({ workspaceName }) => <p>ws:{workspaceName}</p>}
    </WorkspaceGate>,
  );
}

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
});
afterEach(() => {
  cleanup();
  fetchMock.restore();
});

test("a resolved workspace is handed to children", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  const view = renderGate();
  expect(await view.findByText("ws:Acme")).toBeTruthy();
});

test("a signed-in user with no workspace sees the empty state", async () => {
  authMockState.session = {
    user: { id: "u_new", email: "new@example.com", name: "New" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [];
  const view = renderGate();
  expect(await view.findByText("No workspace yet")).toBeTruthy();
});

/** An outage must not masquerade as "you have no workspaces". */
test("an undetermined session shows an error state, not the empty state", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const view = renderGate();
  expect(await view.findByText("Can't load your workspace")).toBeTruthy();
  expect(view.queryByText("No workspace yet")).toBeNull();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test apps/web/src/__tests__/workspace-gate.test.tsx`
Expected: FAIL — no error state exists; the outage case renders "No workspace yet".

- [ ] **Step 3: Rewrite the workspace hooks**

Replace `apps/web/src/lib/workspace.ts` with:

```ts
/**
 * Active-workspace resolution + the viewer's role in it.
 *
 * Workspace = Better Auth organization. Both the workspace list and the
 * active id come from the viewer query (lib/auth/viewer.ts), which is the
 * SPA's single identity source.
 *
 * There is deliberately NO activation effect here any more. Selecting a
 * workspace for a session that has none is the router gate's job
 * (routes/_app.tsx `beforeLoad`), where it is awaited and its failure is
 * visible. The previous fire-and-forget effect latched a ref, ignored the
 * result, and left `isPending` true forever when activation failed.
 *
 * The role comes from the control-plane members list so it reflects exactly
 * what the API will authorize; the server re-checks everything.
 */
import { WORKSPACE_ROLES, type KnownWorkspaceRole } from "@invisible-string/shared";

import { activeWorkspace, useViewer } from "./auth/viewer";
import { useWorkspaceMembers } from "./queries/members";

export interface ActiveWorkspace {
  id: string;
  name: string;
}

export interface UseWorkspaceResult {
  workspace: ActiveWorkspace | null;
  /** True while the viewer is still resolving. */
  isPending: boolean;
  /** Set when the viewer could NOT be determined — distinct from "none". */
  error: Error | null;
}

export function useWorkspace(): UseWorkspaceResult {
  const { viewer, isPending, error } = useViewer();
  const workspace = viewer ? activeWorkspace(viewer) : null;
  return {
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    isPending,
    error,
  };
}

/** The active workspace id + pending flag — the chat/builder accessor. */
export function useActiveWorkspaceId(): {
  workspaceId: string | null;
  isPending: boolean;
} {
  const { workspace, isPending } = useWorkspace();
  return { workspaceId: workspace?.id ?? null, isPending };
}

function parseKnownRole(role: string): KnownWorkspaceRole | null {
  // Better Auth stores multi-roles comma-separated; highest privilege wins.
  const parts = role.split(",").map((part) => part.trim());
  for (const candidate of WORKSPACE_ROLES) {
    if (parts.includes(candidate)) return candidate;
  }
  return null;
}

export interface UseWorkspaceRoleResult {
  /** The viewer's role, null while unknown (loading/error/not a member). */
  role: KnownWorkspaceRole | null;
  /** Owner or admin — may mutate settings. False until the role is known. */
  canManage: boolean;
  isPending: boolean;
}

export function useWorkspaceRole(
  workspaceId: string | undefined,
): UseWorkspaceRoleResult {
  const { viewer } = useViewer();
  const members = useWorkspaceMembers(workspaceId ?? "", {
    enabled: workspaceId !== undefined,
  });

  const userId = viewer?.user.id;
  const member =
    userId === undefined
      ? undefined
      : members.data?.find((candidate) => candidate.userId === userId);
  const role = member ? parseKnownRole(member.role) : null;

  return {
    role,
    canManage: role === "owner" || role === "admin",
    isPending: workspaceId !== undefined && members.isPending,
  };
}
```

- [ ] **Step 4: Give WorkspaceGate an error state**

In `apps/web/src/components/WorkspaceGate.tsx`, pull `error` out of `useWorkspace()` and add a branch **before** the `!workspace` branch. Add `TriangleAlert` to the `lucide-react` import and `Button` to the imports:

```tsx
  const { workspace, isPending, error } = useWorkspace();
```

```tsx
  if (error) {
    return (
      <Panel className="panel-enter flex h-full min-w-0 flex-col overflow-hidden">
        <header className="px-6 pb-4 pt-5">
          <h1 className="text-[17px]">{title}</h1>
        </header>
        <div aria-hidden="true" className="mx-6 h-px bg-black/[0.06]" />
        <div className="flex-1">
          <EmptyState
            icon={TriangleAlert}
            title="Can't load your workspace"
            description="Check your connection, then try again."
          />
        </div>
      </Panel>
    );
  }
```

Update the component's doc comment: an outage now has its own state and no longer renders as "No workspace yet".

- [ ] **Step 5: Migrate the members route off `useSession`**

In `apps/web/src/routes/_app.settings.members.tsx`, replace the import and the hook:

```tsx
import { useViewer } from "../lib/auth/viewer";
```

```tsx
  const { viewer } = useViewer();
```

```tsx
          currentUserId={viewer?.user.id}
```

- [ ] **Step 6: Run the tests**

Run: `bun test apps/web/src/__tests__/workspace-gate.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Verify**

Run: `bun run --cwd apps/web typecheck && bun test apps/web`
Expected: typecheck clean, suite green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/workspace.ts apps/web/src/components/WorkspaceGate.tsx \
        apps/web/src/routes/_app.settings.members.tsx \
        apps/web/src/__tests__/workspace-gate.test.tsx
git commit -m "fix(web): resolve workspaces from the viewer and surface outages"
```

---

## Task 6: Workspace creation and sign-out

**Files:**
- Modify: `apps/web/src/components/onboarding/CreateWorkspaceScreen.tsx`
- Modify: `apps/web/src/components/settings/WorkspacePanel.tsx`
- Test: `apps/web/src/__tests__/create-workspace.test.tsx` (extend)

**Interfaces:**
- Consumes: `refetchViewer`, `completeSignOut`, `SignOutFailedError` (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Replace the contradicting test, then add the new ones**

`apps/web/src/__tests__/create-workspace.test.tsx` currently contains a test named **"creating a workspace calls create + setActive and reveals the shell"** which asserts the exact behaviour this task removes. **Replace that test** — do not append alongside it, or the suite cannot go green.

Replace it with:

```tsx
test("creating a workspace reveals the shell without a redundant setActive", async () => {
  // The server already activates a newly created organization
  // (better-auth crud-org.mjs) — a second client call is a round trip that
  // can fail after the workspace exists.
  authMockState.session = zeroOrgSession();
  authMockState.createOrganizationResult = {
    data: {
      id: "org_new_1",
      name: "Acme Inc",
      slug: "acme-inc-abcdef12",
      createdAt: "2026-07-08T00:00:00.000Z",
    },
    error: null,
  };
  const { view } = renderApp();
  await view.findByText("Create your workspace");
  fireEvent.input(view.getByLabelText("Workspace name"), {
    target: { value: "  Acme Inc  " },
  });
  submitForm(view);

  // Wait for the SHELL, not merely for the create call to be recorded: the
  // component has not finished its post-create work at that point, so
  // asserting on setActive there could pass against the old code too.
  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
  expect(authMockState.createOrganizationCalls).toHaveLength(1);
  expect(authMockState.setActiveCalls).toHaveLength(0);
  expect(view.queryByText("Create your workspace")).toBeNull();
});
```

Keep whatever the replaced test asserted about the trimmed name/slug — carry those assertions across rather than dropping them.

Then append:

```tsx
test("a failed sign-out keeps the user where they are", async () => {
  authMockState.session = zeroOrgSession();
  authMockState.signOutResult = { data: null, error: { status: 500 } };
  const { router, view } = renderApp();
  await view.findByText("Create your workspace");
  fireEvent.click(view.getByRole("button", { name: /sign out/i }));
  expect(await view.findByText("Could not sign out. Try again.")).toBeTruthy();
  expect(router.state.location.pathname).not.toBe("/login");
});
```

The `signOutResult` mock state was already added in Task 1.

- [ ] **Step 2: Run to confirm failure**

Run: `bun test apps/web/src/__tests__/create-workspace.test.tsx`
Expected: FAIL — a `setActive` call is recorded, and the sign-out test navigates anyway.

- [ ] **Step 3: Fix CreateWorkspaceScreen**

In `apps/web/src/components/onboarding/CreateWorkspaceScreen.tsx`:

Replace the imports:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "../../lib/auth-client";
import { completeSignOut, refetchViewer } from "../../lib/auth/viewer";
```

Add `const queryClient = useQueryClient();` beside the other hooks, and replace the body of the create success path:

```tsx
      const created = await authClient.organization.create({
        name: trimmed,
        slug: workspaceSlug(trimmed),
      });
      if (created.error) {
        if (!created.error.status || created.error.status >= 500) {
          connectionFailed();
        } else {
          setFormError(created.error.message ?? "Could not create the workspace.");
        }
        return;
      }
      // The server activates the new organization as part of /organization/create,
      // so no setActive round trip is needed — only a fresh read of the viewer.
      // No navigation either: the layout flips into the shell at this URL.
      //
      // The workspace EXISTS from here on. A refresh failure is a partial
      // success: never tell the user nothing was created, or they will create
      // a second one.
      try {
        await refetchViewer(queryClient);
        toast({ variant: "success", message: "Workspace created." });
      } catch {
        toast({
          variant: "error",
          title: "Workspace created",
          message: "Couldn't load it just yet — reload to continue.",
        });
      }
      return;
```

Because the `try` block's outer `catch` currently maps *any* throw to `connectionFailed()`, the inner `try/catch` above is what stops a post-create refresh failure from being reported as "nothing was created".

Replace `handleSignOut`:

```tsx
  async function handleSignOut() {
    setSigningOut(true);
    try {
      await completeSignOut(queryClient);
      await navigate({ to: "/login" });
    } catch {
      toast({ variant: "error", message: "Could not sign out. Try again." });
      setSigningOut(false);
    }
  }
```

And correct the partial-success copy — `connectionFailed()` in this component must no longer promise nothing was created:

```tsx
  function connectionFailed() {
    toast({
      variant: "error",
      title: "Can't reach the server",
      message: "Check that the API is running, then try again.",
    });
    setFormError("Connection failed — try again.");
  }
```

- [ ] **Step 4: Fix WorkspacePanel**

In `apps/web/src/components/settings/WorkspacePanel.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "../../lib/auth-client";
import { completeSignOut, refetchViewer } from "../../lib/auth/viewer";
```

Add `const queryClient = useQueryClient();`, then after a successful rename refresh the viewer so the shell's workspace name updates:

```tsx
      // The rename has already landed server-side; a failed refresh must not
      // be reported as a failed rename.
      toast({ variant: "success", message: "Workspace renamed." });
      try {
        await refetchViewer(queryClient);
      } catch {
        // The name is saved; the shell will pick it up on the next viewer read.
      }
```

and replace `handleSignOut` with the `completeSignOut` version from Step 3.

- [ ] **Step 5: Run the tests**

Run: `bun test apps/web/src/__tests__/create-workspace.test.tsx`
Expected: PASS.

- [ ] **Step 6: Verify**

Run: `bun run --cwd apps/web typecheck && bun test apps/web`
Expected: typecheck clean, suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/onboarding/CreateWorkspaceScreen.tsx \
        apps/web/src/components/settings/WorkspacePanel.tsx \
        apps/web/src/test/auth-mock.ts \
        apps/web/src/__tests__/create-workspace.test.tsx
git commit -m "fix(web): drop the redundant setActive and check sign-out results"
```

---

## Task 7: Invitation acceptance on the viewer query

**Files:**
- Modify: `apps/web/src/routes/accept-invitation.$invitationId.tsx`
- Test: `apps/web/src/__tests__/accept-invitation.test.tsx` (existing — keep green)

**Interfaces:**
- Consumes: `useViewer`, `refetchViewer`, `completeSignOut` (Task 1).
- Produces: no new exports. The bespoke `SessionProbe` state machine is deleted.

- [ ] **Step 1: Replace the probe with the viewer query**

In `apps/web/src/routes/accept-invitation.$invitationId.tsx`:

Delete the `SessionProbe` type, the `sessionProbe`/`setSessionProbe` state, and the first `useEffect` (the `authClient.getSession()` probe). Replace the imports:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "../lib/auth-client";
import {
  completeSignOut,
  refetchViewer,
  useViewer,
  viewerQueryKey,
} from "../lib/auth/viewer";
```

Inside the component, replace the probe state with:

```tsx
  const queryClient = useQueryClient();
  const { viewer, isPending: sessionPending, error: sessionError } = useViewer();
  // Set when a 401 arrives mid-flow (the session died between requests).
  const [sessionLost, setSessionLost] = useState(false);
```

Update the invitation-fetch effect's guard and dependencies:

```tsx
  useEffect(() => {
    if (!viewer || sessionLost) return;
    // ...unchanged body, except `setSessionProbe("unauthenticated")` becomes
    //    `setSessionLost(true)`
  }, [viewer, sessionLost, invitationId, attempt]);
```

Replace the three pre-content branches:

```tsx
  if (sessionPending) {
    return (
      <InviteCard subtitle="Checking your session">
        <CenteredSpinner label="Loading invitation" />
      </InviteCard>
    );
  }

  if (sessionError) {
    // `attempt` no longer feeds the viewer query, so bumping it alone would
    // leave the same cached error in place and the card could never recover.
    // Drop the cached error, then let the query refetch.
    return (
      <ConnectionErrorCard
        onRetry={() => {
          queryClient.removeQueries({ queryKey: viewerQueryKey });
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  if (!viewer || sessionLost) {
    return (
      <Navigate
        to="/login"
        search={{ redirect: `/accept-invitation/${invitationId}` }}
        replace
      />
    );
  }
```

Replace the three remaining `setSessionProbe("unauthenticated")` calls (in the invitation fetch, `accept`, and `decline`) with `setSessionLost(true)`.

In `accept()`, replace the `setActive` + navigate tail so the viewer is refreshed before the shell resolves:

```tsx
      const activated = await authClient.organization.setActive({
        organizationId: invitation.organizationId,
      });
      if (activated.error) {
        // The membership exists; only switching the active workspace failed.
        toast({
          variant: "error",
          message: `Joined ${invitation.organizationName}, but couldn't switch to it.`,
        });
      } else {
        toast({
          variant: "success",
          message: `Joined ${invitation.organizationName}.`,
        });
      }
      await refetchViewer(queryClient);
      await navigate({ to: "/chat" });
```

In `handleSignOut()`, swap `await signOut()` for `await completeSignOut(queryClient)`.

Finally, replace the stale doc comment above the deleted probe with:

```tsx
  // Identity comes from the shared viewer query (lib/auth/viewer.ts), the same
  // source the router gate uses. This route used to run its own
  // authClient.getSession() probe because the old useSession() atom could hold
  // a stale resolved-null right after login; that atom is gone.
```

- [ ] **Step 2: Update the existing test's expectations if needed**

Run: `bun test apps/web/src/__tests__/accept-invitation.test.tsx`

The tests drive `authMockState.session`, which now also feeds `getSession`. If a test set `session` but not `organizations`, `organization.list()` returns them fine. Fix only genuine breaks — do not weaken assertions.

- [ ] **Step 3: Add a case for the retired residual**

Append to `apps/web/src/__tests__/accept-invitation.test.tsx`:

```tsx
test("an undetermined session shows the retry card, not a login bounce", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const { router, view } = renderInvite("inv_1");
  expect(await view.findByText("Can't load this invitation")).toBeTruthy();
  expect(router.state.location.pathname).toContain("/accept-invitation/");
});

test("Try again recovers once the server answers", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const { view } = renderInvite("inv_1");
  await view.findByText("Can't load this invitation");

  // The retry must drop the CACHED error, not just re-run an effect.
  authMockState.getSessionError = null;
  authMockState.session = demoSession();
  authMockState.getInvitationResult = {
    data: {
      id: "inv_1",
      email: "demo@example.com",
      role: "member",
      status: "pending",
      organizationId: "org_test_1",
      organizationName: "Acme",
      inviterEmail: "owner@example.com",
    },
    error: null,
  };
  fireEvent.click(view.getByRole("button", { name: /try again/i }));
  expect(await view.findByText("Join Acme")).toBeTruthy();
});
```

Match the existing file's render helper name if it differs from `renderInvite`, and add `demoSession` / `fireEvent` to that file's imports if they are not already there.

- [ ] **Step 4: Verify**

Run: `bun run --cwd apps/web typecheck && bun test apps/web`
Expected: typecheck clean, suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/accept-invitation.\$invitationId.tsx \
        apps/web/src/__tests__/accept-invitation.test.tsx
git commit -m "refactor(web): move invite acceptance onto the shared viewer query"
```

---

## Task 8: Remove the Better Auth hooks

**Files:**
- Modify: `apps/web/src/lib/auth-client.ts`
- Modify: `apps/web/src/test/auth-mock.ts`
- Test: `apps/web/src/__tests__/auth-client-surface.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `lib/auth-client.ts` exports only `authClient`, `signIn`, `signUp`, `signOut`.

- [ ] **Step 1: Write the guard test**

Create `apps/web/src/__tests__/auth-client-surface.test.ts`:

```ts
import { expect, test } from "bun:test";

/**
 * Better Auth's React hooks are nanostores atoms whose freshness is tied to
 * component mount lifecycle, and NO signal fires on sign-in — so an atom that
 * resolved while signed out stays 401 for the life of the page. That is the
 * bug this whole surface was rebuilt to remove; re-exporting a hook is how it
 * comes back. Identity comes from lib/auth/viewer.ts, and only from there.
 */
const BANNED = ["useSession", "useActiveOrganization", "useListOrganizations"];

test("lib/auth-client re-exports no Better Auth React hook", async () => {
  const mod = await import("../lib/auth-client");
  for (const name of BANNED) {
    expect(Object.keys(mod)).not.toContain(name);
  }
});

test("no source file imports a Better Auth React hook", async () => {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const root = new URL("../", import.meta.url).pathname;
  const offenders: string[] = [];
  for await (const file of glob.scan({ cwd: root })) {
    if (file.startsWith("__tests__/")) continue;
    const text = await Bun.file(`${root}${file}`).text();
    // Only flag imports FROM better-auth itself; the app has its own
    // useSession (chat sessions) in lib/queries/sessions.ts.
    if (/from\s+["']better-auth\/react["']/.test(text) && file !== "lib/auth-client.ts") {
      offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run to confirm the first test fails**

Run: `bun test apps/web/src/__tests__/auth-client-surface.test.ts`
Expected: FAIL — the three hooks are still exported.

- [ ] **Step 3: Narrow the auth-client surface**

In `apps/web/src/lib/auth-client.ts`, replace the export block and extend the doc comment:

```ts
/**
 * ...existing description...
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

export const { signIn, signUp, signOut } = authClient;
```

- [ ] **Step 4: Delete the mock's hook plumbing**

In `apps/web/src/test/auth-mock.ts`, delete `useActiveOrganization`, `useListOrganizations`, the `useSession` entry in `authMockFactory`, the `useSyncExternalStore` import, and the `orgStoreVersion`/`orgStoreListeners`/`notifyOrgStore`/`subscribeOrgStore`/`getOrgStoreVersion` block plus the long comment explaining them. Keep the `notifyOrgStore()` call sites removed along with the function.

Replace the deleted comment with:

```ts
/**
 * This mock models the SERVER, not a client cache: `getSession` returns
 * whatever session the "server" holds, `organization.list` 401s without one,
 * and signIn/signUp establish a session the way the real endpoints do. The
 * previous version hand-wrote reactive hooks and was, as a result, strictly
 * more correct than the library it replaced — which is why the suite could
 * never fail on the double-login bug.
 */
```

- [ ] **Step 5: Verify**

Run: `bun run --cwd apps/web typecheck && bun test apps/web`
Expected: typecheck clean (any missed consumer is now a compile error), suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/auth-client.ts apps/web/src/test/auth-mock.ts \
        apps/web/src/__tests__/auth-client-surface.test.ts
git commit -m "refactor(web): stop exporting Better Auth React hooks"
```

---

## Task 9: End-to-end coverage

**Files:**
- Modify: `e2e/specs/auth.e2e.ts` (add one case — do **not** create a parallel spec file)
- Modify: `e2e/README.md` (its "Specs" section is the spec inventory)
- Read first: `e2e/README.md`, `e2e/support/flows.ts`

**Interfaces:**
- Consumes: `e2e/support/flows.ts`'s `Account` type, `signUp`, and `createWorkspace` helpers.
- Produces: an E2E case that does **not** start with `page.goto("/login")`.

- [ ] **Step 1: Read the harness**

Read `e2e/README.md` and `e2e/support/flows.ts` in full, plus the whole of `e2e/specs/auth.e2e.ts`, to match the fixture and account-provisioning conventions exactly. `auth.e2e.ts` already covers signup → shell, logout, login, and a bad-password path; this task adds the ordering case it is missing, in that same file.

- [ ] **Step 2: Add the case**

Add a test to `e2e/specs/auth.e2e.ts`. It must:

1. Provision an account **with a workspace** using the existing helpers (`signUp` then `createWorkspace`), then sign out through the UI.
2. Navigate to `/chat` **while signed out** and let the SPA redirect to `/login` on its own. Do not `page.goto("/login")` — that full navigation rebuilds the Better Auth client singleton and destroys the precondition this spec exists to cover (`e2e/support/flows.ts:48` is why CI never caught the bug).
3. Fill and submit the form **once**.
4. Assert `page.waitForURL("**/chat")` and that a workspace-scoped element is visible without any reload — assert on real shell content, not merely the URL.

Add a comment above the test stating rule 2 and why, so nobody "simplifies" it back to `flows.login()`.

- [ ] **Step 3: Update the spec inventory**

`e2e/README.md`'s "Specs (`specs/*.e2e.ts`)" section is the inventory and must not go stale. Extend its **auth** bullet to mention the new case, e.g. *"…login (+ a bad-password path); and signing in ONCE after a signed-out visit to a protected route, without the `page.goto("/login")` that would reset the SPA's auth client."*

- [ ] **Step 4: Run it**

Run: `cd e2e && bunx playwright test specs/auth.e2e.ts --workers=1`
Expected: PASS. (The harness self-manages its stack; `--workers=1` per the repo's e2e notes.)

- [ ] **Step 5: Commit**

```bash
git add e2e/specs/auth.e2e.ts e2e/README.md
git commit -m "test(e2e): cover signing in without a prior page navigation"
```

---

## Task 10: Documentation and release note

**Files:**
- Modify: `AGENTS.md`
- Create: `.changeset/spa-session-state.md`

- [ ] **Step 1: Retire the residual**

In `AGENTS.md`'s "Known residuals" paragraph, delete the entry beginning *"Better Auth session-atom staleness: no useSession subscriber lives on the auth screens…"* through the end of that sentence, including its trailing separator.

- [ ] **Step 2: Add the constraint**

Add this bullet to the **"Constraints that will bite you"** list in `AGENTS.md`:

```md
- **`apps/web` never reads identity through a Better Auth React hook.** `useSession`/`useActiveOrganization`/`useListOrganizations` are nanostores atoms with three separate traps: the session atom reports `isPending: false` while holding a snapshot it never refetched (so a render-time gate bounces a just-signed-in user straight back to `/login` — the double-login bug), the plugin atoms built on `useAuthQuery` fetch exactly ONCE per page load and permanently unbind their signal subscriptions on first unmount, and **no signal fires on `/sign-in/email` or `/sign-up/email`** — so `listOrganizations`/`activeOrganization` resolved while signed out stay 401 for the life of the tab, which is why chat rendered empty until a reload. Identity is the `viewer` query (`apps/web/src/lib/auth/viewer.ts`), fetched through the plain proxy calls (`authClient.getSession()`, `authClient.organization.list()`) that carry no cache; the auth decision happens in `routes/_app.tsx`'s `beforeLoad` and NEVER in render, and `fetchQuery` is required there because `ensureQueryData` returns stale data without revalidating. Better Auth still owns every mutation. Guards: `apps/web/src/__tests__/auth-client-surface.test.ts` (no hook re-exports) and `auth-flow.test.tsx` (sign in once after a signed-out boot).
```

- [ ] **Step 3: Register the spec**

Add a row to the living-documents table in `AGENTS.md`:

```md
| `docs/superpowers/specs/2026-08-31-spa-session-and-workspace-state-design.md` | SPA identity as it stands: the `viewer` query, the `beforeLoad` auth gate, the three-way signed-out/signed-in/undetermined contract, principal-change cache clearing — **supersedes** the auth-gating and workspace-resolution decisions of the 2026-07-02 and 2026-07-10 specs |
```

- [ ] **Step 4: Write the changeset**

Create `.changeset/spa-session-state.md`. Remember: the summary is ONE line, and the bold scope label in the changelog is derived from the package names sorted alphabetically. `patch` is correct — AGENTS.md reserves `minor` for features and 0.x breaking changes, and this is a bug fix.

```md
---
"@invisible-string/web": patch
---

Fix signing in requiring two attempts and workspace content staying blank until a reload, by moving SPA identity off Better Auth's React hooks onto a viewer query gated in the router.
```

- [ ] **Step 5: Verify the whole tree**

Run from the repo root:

```bash
bun run typecheck && bun test && bun run --cwd apps/web build
```

Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md .changeset/spa-session-state.md
git commit -m "docs: record the SPA identity rewrite and retire the session-atom residual"
```

---

## Self-review notes

- **Spec coverage**: §3 → Task 1; §4.1 → Task 2; §4.2/§4.3 → Task 3; §5 → Tasks 1, 4, 6; §6.1/§6.2/§6.5 → Task 5; §6.3 → Task 6; §6.4 → Task 7; §6.6 → Task 8; §7.1 → Tasks 1 and 8; §7.2 → Task 4; §7.3 → Task 9; §9 file table → Tasks 1–10.
- **Type consistency**: `refetchViewer` is the single refresh primitive used by Tasks 4, 6, and 7; `activateWorkspace` is used only by the gate; `useViewer(enabled?)` is the only hook. `viewerQueryKey` is spelled once, in `lib/auth/viewer.ts`.
- **Interim state**: after Task 3 and before Task 5, `_app` reads the viewer while `lib/workspace.ts` still reads Better Auth atoms, and principal-change cache clearing does not land until Task 6. The suite must stay green at every boundary, but **Tasks 3–5 are non-shippable intermediate commits**: a first login works because the old organization hooks first mount after the new gate, while remount and account-switch behaviour stays unsafe until Task 5. Do not cut a release from the middle of this sequence.
