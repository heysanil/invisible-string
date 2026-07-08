# First-run workspace creation & invite acceptance — design

**Date:** 2026-07-07 · **Status:** approved (reviewed via artifact) · **Scope:** `apps/web` only — zero server changes

## Context

A brand-new account dead-ends. Signup navigates to `/chat`; `useWorkspace`
(`apps/web/src/lib/workspace.ts`) self-heals by activating the user's *first*
organization, but with zero organizations it resolves to `null` — chat shows a
misleading "Pick up a conversation" empty state and `WorkspaceGate` promises
"Create or join a workspace…" with no way to do either. A second, adjacent
dead end: `MembersPanel.tsx` hands inviters a copyable link to
`/accept-invitation/:id`, but no such route exists — every shared invite lands
on the SPA's not-found.

The server needs nothing. Better Auth's organization plugin already exposes
create / set-active / invite / accept under `/api/auth/organization/*`, with
`creatorRole: "owner"` and the `afterCreateOrganization → seedWorkspace` hook
(`apps/control-plane/src/auth.ts`) seeding model presets, allowlist, and agent
presets. The SPA simply never calls `create` — only the e2e harness does, via
raw fetch (`e2e/support/flows.ts`).

## Goals

- A zero-org user is carried from signup to a working shell without a dead end.
- Invite links work end-to-end, including for recipients with no account yet.
- Both new surfaces are indistinguishable in quality from the rest of the E1
  product: same primitives, same motion, same designed states.

**Non-goals** (recorded residuals): workspace switcher / creating additional
workspaces from the shell, invite emails (no mailer), signup gating, a
"restrict workspace creation" policy flag.

## Design

### 1. Zero-org gate in the `_app` layout

`_app.tsx` (the authenticated shell) becomes the single owner of the zero-org
state. Using the already-subscribed `useListOrganizations`, when the session
is resolved and the organization list is **empty**, the layout renders the
first-run screen *instead of* the sidebar shell. No new route, no redirects:
the URL stays wherever the user landed, and the moment a workspace exists the
layout re-renders into the normal app — no redirect loops, no back-button
weirdness, deep links survive creation.

- While the list is pending, the existing loading treatment shows; the
  first-run screen never flashes for users who do have workspaces.
- `WorkspaceGate`'s "No workspace yet" branch and chat's null-state panels
  stay as defensive fallbacks for the brief resolution window.

### 2. `CreateWorkspaceScreen` — one field, one action

Framed by `AuthCard` (the centered `glass-panel panel-enter` card over the
wash that login/signup use), so the first-run moment reads as the third act of
the same onboarding sequence.

- **Title/subtitle:** "Create your workspace" / "Workflows, context, and
  members live in a workspace. Name yours to begin."
- **One `Input`:** workspace name. The slug Better Auth requires is derived —
  slugified name + short random suffix — and never shown; slugs surface
  nowhere in the product, so a field would invent surface and collision UX.
- **Submit:** `authClient.organization.create({ name, slug })` →
  `organization.setActive`. Going through `authClient` (not raw fetch) fires
  the server seed hook *and* updates the client nanostores so the shell
  appears without a reload.
- **Validation & errors:** login's pattern exactly — client-side validation
  with focus moved to the first invalid field, inline `role="alert"` error
  in `--err`, connection failures distinguished from 4xx via the shared
  toast treatment, `Button loading` state while in flight.
- **Escape hatches:** a quiet "Have an invite link? Open it to join an
  existing workspace instead." hint, and a subdued **Sign out** link — the
  screen replaces the shell, so it must carry its own way out of the session.

### 3. Invite acceptance — `/accept-invitation/$invitationId`

New route fixing the link `MembersPanel` already ships. Also framed by
`AuthCard`.

- **Signed out** → redirect to `/login?redirect=/accept-invitation/<id>`.
  Login and signup gain a validated `redirect` search param — must start with
  `/` and not `//` (no open redirects) — used in place of the hard-coded
  `/chat`; login ⇄ signup links preserve it so a brand-new invitee can sign
  up and land back on the invite.
- **Signed in** → fetch the invitation (`authClient.organization.getInvitation`),
  show a confirm panel: workspace name, inviter, role (as a `Chip`), with
  explicit **Accept** / **Decline**. No auto-accept on load — link
  prefetchers and wrong-account sessions make GET side effects a footgun.
- **Accept** → `acceptInvitation` → `setActive(organizationId)` → navigate to
  `/chat` with a success toast. This also covers existing users joining a
  second workspace.
- **Designed error states**, each with distinct copy and a recovery action:
  expired / invalid / already-handled invitations, and email mismatch (Better
  Auth binds invitations to the invited email and rejects other accounts —
  the panel narrates that and offers **Sign out** to switch accounts).

### 4. E1 quality bar (explicit acceptance criteria)

Both screens must be indistinguishable from the shipped product — golden rule
5 applies in full:

- **Primitives only:** `AuthCard`, `Input`, `Button`, `Chip`, `Spinner`,
  `Toast`, `ErrorState` — extend `src/components/ui`, never fork one-off
  styles. Tokens from `src/styles/tokens.css`; no new colors.
- **Motion:** `panel-enter` on card mount; state swaps inside the card
  (loading → confirm → error) transition at 150–200 ms `--ease-out`, no
  layout jumps (reserve space for error lines the way login does);
  `prefers-reduced-motion` and `prefers-reduced-transparency` respected via
  the existing global handling.
- **Color as meaning only:** `--err` for failures, `--ok` reserved for the
  success toast; everything else ink.
- **Designed states, no blanks:** the invite route shows a titled loading
  card (spinner) while fetching, never a flash of empty glass; every error
  variant is a designed state with copy that says what happened and what to
  do — no raw API messages.
- **A11y:** `focus-visible` on all interactive elements, labels bound to
  inputs, `role="alert"` on errors, focus moved to the first invalid field.
  In the invite panel, Decline is the ghost button and Accept the primary
  ink capsule, in that DOM order — the primary action lands last in the tab
  sequence.

## Decision log

| Decision | Choice | Why |
|---|---|---|
| Gate placement | Layout-level branch in `_app.tsx`, not a `/welcome` route | Conditional rendering on already-subscribed state; no redirect loops, deep links survive creation |
| Screen frame | Reuse `AuthCard` for both screens | First-run and invite read as the same onboarding sequence as login/signup; motion and glass come for free |
| Slug handling | Derived from name + random suffix, never user-visible | Slugs surface nowhere in the product |
| Invite acceptance | Explicit confirm panel, not auto-accept on load | GET side effects break under prefetching and punish wrong-account sessions |
| Redirect param | Same-app relative paths only (`/…`, never `//…`) | Closes the open-redirect hole while letting invites survive the login/signup round-trip |
| Creation policy | Any authenticated user may create (Better Auth default) | Matches today's server behavior; a restriction flag is a noted residual |
| API surface | Everything via `authClient.organization.*` | Seed hook fires, client stores update, no new control-plane routes — nginx prefix constraint untouched |

## Testing

- **Web unit tests:** `CreateWorkspaceScreen` (create → setActive sequencing,
  error state, disabled-while-submitting) and redirect-param validation, on
  the existing `auth-mock` pattern.
- **E2E — new-user golden path:** signup → first-run screen visible → create
  via UI → shell appears. `flows.ts:signup()` keeps `waitForURL("**/chat")`
  but its post-signup assertion moves to the first-run screen (the URL is
  unchanged by design).
- **E2E — invite round-trip:** owner invites → copies link → fresh browser
  context signs up through the redirect → accepts → appears in members.
  `flows.ts:createWorkspace()` keeps its fast API path for unrelated specs.

## Documentation updates (same commit as the code)

- `README.md` — product-surfaces section gains the signup → first-run flow
  and the invite-link journey.
- No new environment variables — `.env.example` untouched. No new
  control-plane route prefixes — `infra/nginx/web.conf` untouched.
