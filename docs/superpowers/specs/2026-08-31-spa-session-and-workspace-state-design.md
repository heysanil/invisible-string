# SPA session + workspace state — Design (2026-08-31)

Supersedes the auth-gating and workspace-resolution decisions of the 2026-07-02 design spec and the 2026-07-10 agents-first redesign wherever they assume the SPA reads identity through Better Auth's React hooks. It also supersedes three decisions of the **2026-07-07 first-run workspace design**, whose §1 and §2 still prescribe them:

- **`useListOrganizations` as the zero-org signal.** That atom is exactly the one §1.2 shows fetching once per page load and freezing at 401. The zero-org branch reads `viewer.workspaces.length === 0` instead.
- **The explicit post-create `setActive`.** `/organization/create` already activates the new organization server-side; the client call is a second round trip that can fail after the workspace exists (§6.3).
- **Nanostore-driven shell resolution** — "the moment a workspace exists the layout re-renders into the normal app". The layout re-renders because the viewer query is refetched, not because an atom signalled.

Its product decisions — the zero-org gate living in the `_app` layout, the single-field `AuthCard` screen, the invite flow's states — are unchanged. It also **retires the "Better Auth session-atom staleness" known residual** in `AGENTS.md` — the per-route `authClient.getSession()` probe that residual describes is removed here, not generalized.

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
3. **A navigation's auth decision happens in `beforeLoad`.** Never from a snapshot read during render — which is not the same as "never in render": §4.3 keeps a live render-time observer on purpose, because `beforeLoad` runs only on navigation and a session can end without one. The rule is about the VALUE, not the location. Authoritative query state with an honest `isPending` is safe to branch on; a Better Auth atom reporting `isPending: false` over data it never fetched is not.
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
refetchOnWindowFocus: "always",
refetchOnReconnect: "always",
```

- `staleTime: 30_000` keeps `beforeLoad` a cache hit for in-app navigation. Without it, every route change inside `_app` would issue a `/get-session`.
- `retry: false` overrides the app default (`retry: 1`, `__root.tsx:9`). The gate blocks navigation, so it must fail fast into the retry card rather than double the time-to-error.
- `refetchOnWindowFocus: "always"` overrides the app default of `false`. This is load-bearing, not a nicety: it is how a session revoked or signed out in another tab is noticed. Leaving Better Auth's session manager costs us its `BroadcastChannel` cross-tab sync, and a focus refetch reproduces the practical effect of it with no new machinery.

  **`"always"`, not `true`.** In `@tanstack/query-core@5.101.2` the option is resolved by `shouldFetchOn`:

  ```js
  return value === "always" || (value !== false && isStale(query, options));
  ```

  So `true` means "refetch on focus **if stale**" — and this query is deliberately fresh for 30 s. A session revoked in another tab five seconds ago would therefore survive the very refocus meant to catch it, and staleness alone never schedules a request: nothing would happen until the next navigation or reload. `refetchOnReconnect` reads through the identical helper and gets the identical treatment. The cost is two requests per refocus (`/get-session` + `/organization/list`), which is the price of the guarantee.

### 3.3 Every request is bounded

`AUTH_REQUEST_TIMEOUT_MS` (15 s) bounds `getSession`, `organization.list`, and `organization.setActive`. Without it a proxy that ACCEPTS the request and never completes the response leaves `beforeLoad`'s promise pending forever: the protected route never commits, and the retry card is unreachable precisely because nothing throws.

The signal rides `fetchOptions`, which Better Auth's dynamic-path proxy spreads into the options it hands `@better-fetch/fetch` (`dist/client/proxy.mjs`); better-fetch prefers `opts.signal` over its own controller and passes it straight to `fetch`. Its own `timeout` option is deliberately unused — it is cleared the moment response *headers* arrive, so a body that never completes would still hang.

A timeout must surface as **undetermined**, and it does for free: an aborted `fetch` rejects, and better-fetch calls `await fetch(...)` with no `try`/`catch`, so the rejection reaches the same wrapper that already converts transport failures to `ViewerUnavailableError`.

### 3.4 What is deliberately not fetched

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
    const activated = await activateWorkspace(context.queryClient, viewer.workspaces[0]!.id);
    if (!activated) throw redirect({ to: "/login", search: { redirect: location.href }, replace: true });
    if (activeWorkspace(activated) === null && activated.workspaces.length > 0) {
      throw new ActivateWorkspaceError("The workspace could not be selected.");
    }
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

**Activation's RESULT is checked, not discarded.** `activateWorkspace` re-reads the viewer, and that read can answer any of the three ways the viewer query can. `null` means the session died mid-activation: it has to redirect *here*, while `location.href` is still the page the user asked for — committing the route and letting §4.3's `<Navigate>` handle it carries no `redirect` search param, so signing back in silently drops them on `/chat`. A viewer that still has no active workspace means the activation did not stick, which must fail visibly rather than commit a shell `WorkspaceGate` cannot resolve. (The `workspaces.length > 0` guard on that second check matters: a user who was removed from every workspace legitimately has no active one, and that is first-run onboarding, not an error.)

**A 401 from `setActive` is signed-out, not an outage.** The session can expire between the viewer read and this call. `activateWorkspace` therefore returns `Viewer | null` on the same contract as the query itself and only wraps non-401 failures as `ActivateWorkspaceError`; a rejected promise (transport, or the timeout abort from §3.3) is wrapped, because it is an absence of an answer rather than an answer.

Workspace selection is deterministic: `workspaces[0]` after the sort defined in §3, never "whatever row order the API returned".

### 4.3 `errorComponent` and `AppLayout`

`SessionUnavailableScreen` renders the designed retry card — the same shape `accept-invitation.$invitationId.tsx` already uses for this exact condition.

Its "Try again" does **two** things, because the screen is reached two ways and each way needs one of them: `router.invalidate()` is the only thing that resets an ERRORED route match (`errorComponent`), and `refetchViewer` is the only thing that reaches a MOUNTED observer when the match is `status: 'success'` and the error lives purely in query state (the live observer below) — there, `invalidate()` alone just re-runs `beforeLoad` against a warm cache and changes nothing on screen. It deliberately does not call the boundary's `reset` (which never re-runs `beforeLoad`) and deliberately does not `removeQueries` the viewer (which detaches the mounted observer from the cache entry, so no later fetch under that key can reach it).

`AppLayout` keeps only what genuinely belongs in render — a live `useQuery(viewerQueryOptions())` observer, branching on **all three** arms of §3.1 in the gate's own order:

- `error` → `SessionUnavailableScreen`. Undetermined is not "fine": a focus refetch that throws leaves `useViewer()` holding both the previous viewer and an error, and rendering the shell over that stale data silently downgrades "couldn't ask" to "everything is fine". Ignoring this arm is what made the contract hold only on initial navigation.
- `null` → `/login`. Expired, or signed out in another tab.
- workspaces but no *resolvable* active one → re-enter the gate (`router.invalidate()` from an effect) and hold a pending state. `beforeLoad` is the only place that awaits activation and it does not re-run without a navigation, so this state — the active organization removed elsewhere — used to leave the shell up over a `WorkspaceGate` that could only show its defensive empty state: stuck until a manual reload. `invalidate()` re-runs `beforeLoad` (router-core's `shouldSkipLoader` does not skip a successful match); a failure there throws into `errorComponent`, and the effect fires only on the transition into the state, so it cannot spin.
- zero workspaces → `CreateWorkspaceScreen`.
- otherwise → `AppShell`.

**This render-time decision is deliberate and is not the bug returning.** §2's rule 3 is about the VALUE, not the location: what made the old gate unsafe was reading a Better Auth atom that reported `isPending: false` over data it never fetched. This observer reads authoritative query state whose `isPending` is honest. It exists because `beforeLoad` runs only on navigation while a session can end without one, so *something* has to branch on the viewer between navigations — and the gate remains the only thing that decides a navigation.

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

### 5.2 A principal can change without this tab doing anything

`completeSignIn`/`completeSignOut` only cover a switch made in **this** tab. Cookies are shared across tabs; QueryClients are not. So if another tab signs Alice out and Bob in, this tab simply refetches its viewer and becomes Bob — while every `["me"]` entry still holds Alice's rows, under a prefix that is byte-identical for every user. A mounted personal-skill or personal-connection route then renders Alice's instructions as Bob.

The purge is therefore keyed on the **resolved principal**, not on the sign-in call, and it runs inside the viewer query function:

```ts
queryFn: async ({ client }) => {
  const viewer = await fetchViewer();
  purgeOnPrincipalChange(client, viewer);   // removes every non-viewer query
  return viewer;
},
```

Three properties make that placement the right one:

- **It is strictly before the commit.** The query function resolves before `setData`, so no render can observe the new principal beside the old principal's data. A `useEffect` afterwards is too late by construction — the offending frame has already painted.
- **`undefined` is not a change.** A cache that has never resolved a viewer has no previous principal to leak from. `getQueryData` distinguishes it from a cached `null`, which *is* a principal (nobody).
- **A throw is not a change.** The function never reaches the purge, which is correct: "couldn't ask" must evict nothing.

`null → Viewer`, `Viewer → null`, and `Viewer(a) → Viewer(b)` all count. The same principal resolving again does not, or every refocus would become a full app reload.

### 5.3 Sign-out must check its result

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

**Acceptance is a commit point.** `acceptInvitation` consumes the invitation and creates the membership, both irreversible. Anything that fails after it must not route the user back to a state whose only recovery re-reads the invitation: the retry would fetch a consumed invite and report "no longer valid", stranding somebody who is already a member. So a `joined` view is set the instant acceptance returns, and it is rendered **ahead of** every session and invitation guard on the page — a session hiccup must not fall through to "Can't load this invitation", and a `null` viewer must not bounce to `/login` carrying the consumed invitation as its redirect. Its only control retries workspace entry (activate → refresh viewer → navigate). Same partial-success principle as `login.tsx`, `signup.tsx`, and `CreateWorkspaceScreen.tsx`; this is the fourth instance of that shape, not a new one.

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

### 7.3 Tests that must fail when their subject is deleted

A test that cannot fail is worse than no test, and several here could not:

- The signed-out gate case could not tell WHICH code redirected — `AppLayout`'s render-time `<Navigate>` produces the same final pathname, and `router.state.matches` after settling is identical either way. It records every route id that ever commits (a route the gate turns away never appears) and pins the `?redirect=` search param, which only `beforeLoad` builds.
- The activation case could not detect a missing `await`: the mock mutated its session synchronously before returning an already-resolved promise, so ordering was unobservable. Activation parks on a deferred promise instead.
- The principal purge is asserted per rendered FRAME, not on the settled DOM — an effect that cleaned up afterwards would pass an "eventually correct" assertion while still having painted the leak.
- The focus options are covered behaviourally (a revoked session inside `staleTime`), so flipping them back to `true` fails the suite; asserting the literal option value would only restate the code.

### 7.4 E2E

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
| `apps/web/src/__tests__/viewer-principal.test.tsx` | **new** — §5.2, asserted per rendered frame |
| `apps/web/src/__tests__/viewer-focus.test.tsx` | **new** — focus/reconnect liveness (§3.2) and the activation re-entry (§4.3) |
| `apps/web/src/__tests__/workspace-panel.test.tsx` | **new** — rename-refresh partial success, both sign-out outcomes |
| `e2e/specs/*.e2e.ts` | **new** — the §7.3 spec |
| `AGENTS.md` | retire the residual; add the Better Auth hooks rule |
| `docs/superpowers/specs/2026-07-07-first-run-workspace-design.md` | mark its three superseded technical decisions |
| `.changeset/*.md` | release note |
