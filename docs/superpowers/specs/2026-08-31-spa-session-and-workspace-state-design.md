# SPA session + workspace state — Design (2026-08-31)

Supersedes the auth-gating and workspace-resolution decisions of the 2026-07-02 design spec and the 2026-07-10 agents-first redesign wherever they assume the SPA reads identity through Better Auth's React hooks. It also **retires the "Better Auth session-atom staleness" known residual** in `AGENTS.md` — the per-route `authClient.getSession()` probe that residual describes is removed here, not generalized.

Nothing in `apps/control-plane` changes. No schema change, no migration, no `COMPILER_VERSION` bump, no `BUILD_ENV_EPOCH` bump.

---

## 1. The bug this exists to kill

Two user-visible symptoms in the deployed app:

1. Credentials must be entered **twice** to get in.
2. Once in, chat and workspace content stay blank **until a manual page refresh**.

Both are the same defect: `apps/web/src/routes/_app.tsx` decides authentication *during render*, from a Better Auth nanostores snapshot that is neither fresh nor honest about its own freshness.

### 1.1 Why the password must be entered twice

`/login` sits outside the `_app` layout, and `_app` is the **only** `useSession()` subscriber in the app. So the atoms are unsubscribed for the entire time the login form is on screen.

| Step | Atom state |
|---|---|
| Open the app signed out | `_app` mounts; `/get-session` → `null`, `/organization/list` → 401 |
| `_app` renders `<Navigate to="/login">` and unmounts | atoms hold `{data: null, isPending: false}` |
| Sign-in succeeds — **the cookie is set correctly** | Better Auth defers its session signal by `setTimeout(…, 10)` (`dist/client/proxy.mjs`); `login.tsx:78` navigates immediately |
| `navigate({to: "/chat"})` → `_app` remounts | `useStore` runs `useRef(store.get())` — reads the **stale resolved-null** |
| First render: `isPending === false`, `session === null` | `_app.tsx:59` → `<Navigate to="/login">` — bounced |

Measured against the real `better-auth@1.6.23` client with a stubbed fetch, at three different remount delays (1.2 s / 2.2 s / 3.2 s after unmount), the first-render snapshot was `data=null isPending=false` **in every case**. The bounce is the default path, not a rare race.

`isPending: false` alongside stale data is the whole problem. A cache that reports "I am not loading" while holding a value it knows nothing about is unsafe to gate on, and no amount of care at the call site fixes that.

### 1.2 Why content stays blank until a refresh

This half survives the fix `AGENTS.md` proposes ("a root-level session subscriber"), which is why it is the more important half.

Better Auth builds its plugin atoms with `useAuthQuery` (`dist/client/query.mjs`), which differs from the session atom in two decisive ways:

- a one-shot `isInitialized` latch — the query fetches **once per page load**, ever;
- an unmount cleanup that runs `for (const u of cleanups) u()`, **permanently unbinding its signal subscriptions**.

And the organization plugin's signals (`dist/plugins/organization/client.mjs`) are:

| atom | listens to | fired by |
|---|---|---|
| `listOrganizations` | `$listOrg` | `/organization/create`, `/delete`, `/update` |
| `activeOrganization` | `$activeOrgSignal` | `/sign-out`, any `/organization/*` |

**Neither signal fires on `/sign-in/email` or `/sign-up/email`.** So the org atoms fetch exactly once — while the user is signed out, returning 401 — and stay frozen there for the life of the tab. `useWorkspace()` then yields `workspace: null`, `WorkspaceGate` renders "No workspace yet", and chat renders nothing. A hard refresh rebuilds the client from scratch, which is why refreshing appears to fix it.

Verified: adding a permanent root-level `useSession()` subscriber makes the **session** atom recover after sign-in, and leaves `listOrganizations` and `activeOrganization` at `data: null, error: 401`. Shipping the documented fix alone would have left symptom 2 exactly as the user reported it.

### 1.3 A third, timing-dependent wedge

Better Auth's session-atom unmount destroy calls `settleAbortedFetch()` → `session.get()` (`dist/client/session-atom.mjs`). Nanostores' delayed unmount sets `$store.active = false` **before** running destroys (`nanostores/lifecycle/index.js`), and `$atom.get()` on an unmounted atom performs `listen(() => {})()`. So that `get()` re-enters `listen`, flips `active` back to `true`, and pushes a fresh destroy onto the `events[UNMOUNT]` array the `for…of` is **currently iterating** — clearing the `setTimeout(fetchSession, 0)` it just scheduled.

Remount ~1.2 s after unmount and the session atom never refetches again; remount at ~2.2 s and it recovers. This is an amplifier, not the cause — §1.1 is sufficient on its own — but it explains why the failure is sometimes worse than two attempts.

### 1.4 Why the test suites are green

Both are structurally incapable of failing on this:

- `apps/web/src/test/auth-mock.ts` replaces the entire auth client with hand-written hooks that re-read a plain mutable object on every render. The mock is **more correct than the library it replaces** — it has no mount lifecycle, no signals, and no staleness.
- `e2e/support/flows.ts:48`'s `login()` helper begins with `page.goto("/login")`, a full navigation that rebuilds the auth-client singleton. `_app` therefore never records a signed-out snapshot before the sign-in, which is the exact precondition for the bug. `signUp()` starts at `/signup` for the same reason.

---

## 2. Decision

Stop reading identity through Better Auth's reactive hooks. Own it in TanStack Query — already a dependency — and gate the app in the router rather than in render.

Better Auth remains the transport and keeps owning every **mutation** (`signIn`, `signUp`, `signOut`, and all of `authClient.organization.*`); the server's `afterCreateOrganization` hook that seeds workspace defaults is unaffected. What changes is that nothing **reads** through its nanostores.

Four rules, in force from this spec onward:

1. **`apps/web` never imports a Better Auth React hook.** `useSession`, `useActiveOrganization`, and `useListOrganizations` stop being exported from `lib/auth-client.ts`.
2. **Identity is one query.** One `viewer` query owns user, active workspace, and workspace list.
3. **The auth decision happens in `beforeLoad`, never in render.**
4. **"Signed out" and "couldn't ask" are different answers** and must stay different all the way to the UI.

---

## 3. The viewer query

New module: `apps/web/src/lib/auth/viewer.ts`.

```ts
export interface ViewerWorkspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Viewer {
  user: { id: string; email: string; name: string };
  activeWorkspaceId: string | null;
  workspaces: ViewerWorkspace[];   // sorted: createdAt asc, then id asc
}
```

`queryFn` calls `authClient.getSession()` and then `authClient.organization.list()`. Both are **plain dynamic-path-proxy calls** — they carry no atom, no signal, and no cache, so they always hit the network. That is precisely why they are the right primitives here and why `accept-invitation` already reached for `getSession()` directly.

### 3.1 The three-way contract

The `queryFn`'s result type is `Viewer | null`, and it may also throw. Those are three distinct outcomes and every consumer branches on all three:

| Server says | Result | Meaning |
|---|---|---|
| session `null`, or 401 on either call | resolves `null` | Definitively signed out |
| session + org list | resolves `Viewer` | Signed in |
| network failure, or status ≥ 500 | **throws** `ViewerUnavailableError` | Could not determine |

Conflating the first and third rows is what makes a control-plane restart look like a logout today (`_app.tsx`'s doc comment says so outright: *"unauthenticated (or unreachable-API) visitors are sent to /login"*). A user whose session is fine must never be shown a login form because a request failed — they will type valid credentials into a form that also cannot reach the server.

A 401 on `/organization/list` is treated as signed out rather than as an error: it can only mean the session died between the two calls.

### 3.2 Query options

```ts
staleTime: 30_000,
retry: false,
refetchOnWindowFocus: true,
refetchOnReconnect: true,
```

- `staleTime: 30_000` keeps `beforeLoad` a cache hit for in-app navigation. Without it, every route change inside `_app` would issue a `/get-session`.
- `retry: false` overrides the app default (`retry: 1`, `__root.tsx:9`). The gate blocks navigation, so it must fail fast into the retry card rather than double the time-to-error.
- `refetchOnWindowFocus: true` overrides the app default of `false`. This is load-bearing, not a nicety: it is how a session revoked or signed out in another tab is noticed. Leaving Better Auth's session manager costs us its `BroadcastChannel` cross-tab sync, and a focus refetch reproduces the practical effect of it with no new machinery.

### 3.3 What is deliberately not fetched

`/organization/get-full-organization` is dropped entirely. The active workspace is derived:

```ts
workspaces.find((w) => w.id === viewer.activeWorkspaceId) ?? null
```

The only fields any surface needs are `id` and `name` (`WorkspaceContext` in `components/WorkspaceGate.tsx`), and the viewer's role comes from the control plane's members list, not from Better Auth. One fewer request per boot, and one fewer atom that can freeze.

---

## 4. The gate

### 4.1 Router context

`__root.tsx` becomes `createRootRouteWithContext<{ queryClient: QueryClient }>()`. The `QueryClient` moves out of `__root.tsx` into its own module (`lib/query-client.ts`) so `main.tsx` can pass it as router context and route `beforeLoad`s can reach it. `RootLayout` still renders the `QueryClientProvider` around the tree, from the same instance.

### 4.2 `_app.beforeLoad`

```ts
beforeLoad: async ({ context, location, cause }) => {
  if (cause === "preload") return;
  if (FIXTURE_MODE) return;

  const viewer = await context.queryClient.fetchQuery(viewerQueryOptions());
  if (!viewer) {
    throw redirect({ to: "/login", search: { redirect: location.href }, replace: true });
  }
  if (activeWorkspace(viewer) === null && viewer.workspaces.length > 0) {
    await activateWorkspace(context.queryClient, viewer.workspaces[0]!.id);
  }
},
errorComponent: SessionUnavailableScreen,
component: AppLayout,
```

Four decisions in that block:

**`fetchQuery`, never `ensureQueryData`.** In `@tanstack/query-core@5.101.2`, `ensureQueryData` returns cached data immediately even when stale, and only revalidates in the background when `revalidateIfStale` is passed. A gate built on it would authorize from a stale cache — the same defect in a new library. `fetchQuery` honours `staleTime`, so it returns cached data when fresh and fetches when not.

**`cause === "preload"` returns early.** `beforeLoad`'s `cause` is `'preload' | 'enter' | 'stay'`. The router runs with `defaultPreload: "intent"` (`main.tsx:8`), so hovering a link would otherwise let a prefetch make an authentication decision. Preloading may warm data; it may never decide auth.

**The redirect is `throw redirect(...)`.** It is atomic with navigation resolution, unlike a `<Navigate>` element whose effect races the commit that rendered it. This is what makes the §1.1 failure mode unrepresentable: there is no render in which a stale value can be read, because the route does not commit until the gate resolves.

**Activation is awaited here, not fired-and-forgotten in a hook.** `lib/workspace.ts:45` currently calls `authClient.organization.setActive()` from an effect, ignores the result, and latches `activationRequested.current = true` so it never retries. A failed activation with a non-empty org list leaves `isPending` true **forever** — an infinite spinner with no error state and no recovery. Moving it into `beforeLoad` makes it awaited, makes its failure an error that reaches `errorComponent`, and makes it resolved before first paint.

Workspace selection is deterministic: `workspaces[0]` after the sort defined in §3, never "whatever row order the API returned".

### 4.3 `errorComponent` and `AppLayout`

`SessionUnavailableScreen` renders the designed retry card — the same shape `accept-invitation.$invitationId.tsx` already uses for this exact condition. "Try again" invalidates the viewer query and calls the router's `reset`.

`AppLayout` keeps only what genuinely belongs in render:

- a live `useQuery(viewerQueryOptions())` observer, so a focus refetch that resolves `null` (expired or signed out elsewhere) leaves the shell for `/login`;
- zero workspaces → `CreateWorkspaceScreen`;
- otherwise → `AppShell`.

A render-time redirect is acceptable **here** and not in today's code, because the value being read is authoritative query state whose `isPending` is honest, not a snapshot that reports `isPending: false` over data it never fetched.

---

## 5. Principal transitions

New in `lib/auth/viewer.ts`:

```ts
export async function completeSignIn(queryClient: QueryClient): Promise<Viewer | null> {
  queryClient.clear();
  return queryClient.fetchQuery(viewerQueryOptions());
}

export async function completeSignOut(queryClient: QueryClient): Promise<void> {
  const { error } = await signOut();
  if (error) throw new SignOutFailedError(error);
  queryClient.clear();
}
```

`login.tsx` and `signup.tsx` call `completeSignIn` **after** the credential call succeeds and **before** navigating. This is the direct answer to §1.1: the app never depends on Better Auth's 10 ms-deferred signal, and by the time `beforeLoad` runs, its `fetchQuery` is a warm cache hit rather than a second round trip. A throw from `completeSignIn` surfaces on the form as the existing connection-failed state — the user stays on a page that can tell them what happened.

### 5.1 `queryClient.clear()` is doing two jobs

Beyond guaranteeing the gate reads fresh, it closes a real cross-account leak. `lib/queries/keys.ts:31` scopes user-level data under a bare `["me"]` prefix:

```ts
return ref.scope === "user" ? ["me"] : ["ws", ref.workspaceId];
```

Nothing clears that today, so signing out and signing in as a different user in the same tab can read the previous account's cached data before any refetch lands. Clearing on **every** principal change — sign-in, sign-up, and sign-out — makes the cache principal-scoped by construction, which is simpler and safer than partitioning every key by user id.

### 5.2 Sign-out must check its result

Better Auth resolves HTTP failures as `{ error }` rather than throwing. All three current call sites — `CreateWorkspaceScreen.tsx:89`, `settings/WorkspacePanel.tsx:66`, `accept-invitation.$invitationId.tsx:209` — `await signOut()` inside a `try/catch` and then navigate, so a failed sign-out sends the user to `/login` with a still-valid session cookie. `completeSignOut` throws on `{ error }` so the existing `catch` blocks do what they already look like they do.

---

## 6. Surfaces that read workspace state

### 6.1 `lib/workspace.ts`

Rewritten on the viewer query. `useWorkspace()` returns `{ workspace, isPending, error }` — the new `error` is what lets `WorkspaceGate` stop lying. The fire-and-forget activation effect and its `activationRequested` ref are deleted; activation lives in the gate (§4.2).

`useWorkspaceRole()` keeps its shape and its control-plane members-list source; it only swaps `useSession()` for `useViewer()` to get the user id.

### 6.2 `WorkspaceGate`

Gains an error branch, distinct from the empty state. Today an org-resolution outage renders the friendly "No workspace yet" panel, so an outage is indistinguishable from a new account. `_app.tsx:76-83` even acknowledges this — it deliberately falls through to the shell on org errors and defers to `WorkspaceGate`, which has no error state to defer to.

### 6.3 `CreateWorkspaceScreen`

Three fixes:

- **Drop the redundant `setActive`.** `/organization/create` already activates the new organization server-side (`dist/plugins/organization/routes/crud-org.mjs:142`, guarded only by `keepCurrentActiveOrganization`). The client call is a second round trip that can fail after the workspace exists.
- **Refetch the viewer instead.** The layout then flips into the shell in place, preserving today's deliberate no-navigation behaviour.
- **Stop reporting partial success as total failure.** The current path reports "Connection failed — nothing was created" when the workspace *was* created and only activation failed, inviting a duplicate.

### 6.4 `accept-invitation.$invitationId.tsx`

Its bespoke `sessionProbe` state machine — which exists solely to work around §1.1 — is replaced by the shared viewer query. Its three states map one-to-one (`checking` → `isPending`, `authenticated`/`unauthenticated` → `Viewer`/`null`, `failed` → thrown). After accept + `setActive`, the viewer is invalidated so the shell resolves the new workspace.

### 6.5 `_app.settings.members.tsx`

Swaps `useSession()` for `useViewer()`. No behaviour change.

### 6.6 `lib/auth-client.ts` — the guardrail

Stops exporting `useSession`, `useActiveOrganization`, and `useListOrganizations`, with a comment stating why. `authClient`, `signIn`, `signUp`, and `signOut` remain. This is what stops the next person from reintroducing the bug by reaching for the obvious hook — a rule that only lives in a doc is a rule that gets re-broken.

---

## 7. Testing

### 7.1 The mock becomes honest by construction

Once nothing consumes a Better Auth React hook, `test/auth-mock.ts` no longer has to hand-write reactive stores. It stubs exactly the async calls the viewer query makes — `authClient.getSession()` and `authClient.organization.*` — so it cannot diverge from the real client the way today's hooks do. The `useSyncExternalStore` plumbing and the `notifyOrgStore` machinery are deleted with the hooks they existed to imitate.

### 7.2 The regression test

The test that must exist asserts the **ordering** that broke, in one continuous app lifetime:

1. mount the router at `/chat` with the mock signed out;
2. assert the redirect to `/login`;
3. flip the mock to signed-in and submit the form **once**;
4. assert the shell renders, with **no remount of the app and no second submit**.

Step 4 is the assertion today's code fails. Any test that starts at `/login`, or that re-creates the router between steps, tests nothing — it destroys the precondition.

### 7.3 E2E

A spec that deliberately does **not** call `flows.login()`, because that helper's `page.goto("/login")` (`e2e/support/flows.ts:48`) is exactly what masks this in CI. Navigate to `/chat` signed out, let the SPA redirect, sign in once, and assert workspace content is on screen.

---

## 8. Out of scope

- **`apps/control-plane` is untouched.** Setting `session.activeOrganizationId` server-side at session creation (`databaseHooks.session.create.before`) would remove a round trip on login, but it is an optimization, not a fix: a fresh signup has no organization when its session is created, so the client must handle "signed in, no active workspace" regardless. Worth doing later; not needed here.
- **Email verification.** `AUTH_REQUIRE_EMAIL_VERIFICATION` is exposed while `createAuth` supplies no `sendVerificationEmail`, so enabling it in production would return a successful signup that sends nothing while the SPA navigates on as if authenticated. This is the existing "no mailer" residual and is not addressed here.

---

## 9. Files

| File | Change |
|---|---|
| `apps/web/src/lib/auth/viewer.ts` | **new** — viewer query, `completeSignIn`/`completeSignOut`, `activateWorkspace` |
| `apps/web/src/lib/query-client.ts` | **new** — the shared `QueryClient` |
| `apps/web/src/components/auth/SessionUnavailableScreen.tsx` | **new** — the retry card |
| `apps/web/src/lib/auth-client.ts` | stop exporting the three hooks |
| `apps/web/src/routes/__root.tsx` | `createRootRouteWithContext`; import the shared client |
| `apps/web/src/main.tsx` | pass `context: { queryClient }` |
| `apps/web/src/routes/_app.tsx` | `beforeLoad` gate, `errorComponent`, slimmed `AppLayout` |
| `apps/web/src/routes/login.tsx`, `signup.tsx` | `completeSignIn` before navigating |
| `apps/web/src/lib/workspace.ts` | rewritten on the viewer |
| `apps/web/src/components/WorkspaceGate.tsx` | error branch |
| `apps/web/src/components/onboarding/CreateWorkspaceScreen.tsx` | §6.3 |
| `apps/web/src/components/settings/WorkspacePanel.tsx` | `completeSignOut`; invalidate viewer on rename |
| `apps/web/src/routes/accept-invitation.$invitationId.tsx` | viewer query replaces the probe |
| `apps/web/src/routes/_app.settings.members.tsx` | `useViewer()` |
| `apps/web/src/test/auth-mock.ts` | drop the hooks; stub the async calls |
| `apps/web/src/__tests__/auth-flow.test.tsx` | **new** — the §7.2 regression test |
| `e2e/specs/*.e2e.ts` | **new** — the §7.3 spec |
| `AGENTS.md` | retire the residual; add the Better Auth hooks rule |
| `.changeset/*.md` | release note |
