# Browser E2E (Playwright)

A real Chromium browser drives the **built** SPA against the **full** compose
stack — zero manual steps. `global-setup.ts` brings everything up; the specs
only ever poll real UI state (no arbitrary sleeps); `global-teardown.ts` tears
it all down.

## What runs

The global setup (in order):

1. `docker compose -p p2e2e up` — postgres, garage, dex, meilisearch (ports
   offset from the dev `:5432/:3900/:5556/:7700` and phase-1 `:5443` stacks,
   so all three coexist; meilisearch rides `:7710`).
2. Fresh product DB + migrations + demo seed (`scripts/db-setup.ts`, under Bun).
3. Production `vite build` of the SPA with `VITE_API_URL` baked at the
   control-plane origin.
4. Managed processes with readiness gates: **stub server** (a real MCP server
   on the official SDK + the MCP-registry REST API + an OAuth-protected MCP
   endpoint at `/mcp-oauth` where EVERY request — the `initialize`/`tools/list`
   handshake included — demands a bearer the stub AS issued, answering
   anything else with a 401 and the RFC 9728 `WWW-Authenticate` challenge
   (PRM pointer + scope), exactly as Vercel/Linear/Notion/Sentry do), **stub
   OAuth AS** (`scripts/stub-as.ts` — RFC 8414 metadata, an
   interstitial-Approve `/authorize`, PKCE-validating `/token` with a
   refresh grant and deliberately short 30 s access tokens, RFC 7591 DCR, and
   the `__expire`/`__mode`/`__introspect`/`__stats` test hooks),
   **control-plane**, **worker**, **vite preview**. Node 24 (mise) is pinned
   first on the control-plane/worker PATH so the real `eve build` and agent
   boot never fall through to a system Node. The control plane also gets
   `PLATFORM_API_URL` (its own origin) so compiled agents with
   broker-delivered OAuth connections can reach
   `POST /internal/connections/token`.
5. A gate on the **registry→Meilisearch sync**: the control plane's sync ETL
   (ticking fast — `REGISTRY_SYNC_INTERVAL_MS=5000`) pages the stub registry
   into the community-search index; setup polls `GET /mcp-registry/search`
   (through a throwaway Better Auth session) until the stub server is
   indexed, so the search-lane specs never race the first sync.

Everything except the LLM is real: Better Auth, the compiler, a real
`eve build`, the worker + a real compiled agent, and eve's built-in mock model
(`EVE_MOCK_AUTHORED_MODELS`) so no provider key is ever needed. The copilot
runs on a deterministic scripted fake (`COPILOT_FAKE_SCRIPT` — see
`support/copilot-script.ts`). The control plane boots with
`MCP_PROBE_ALLOW_PRIVATE=1`: the connection health probes (after-create and
Test connection) ride the guarded egress fetch, which would otherwise reject
the stub MCP server twice over (loopback address, plain http).

## Specs (`specs/*.e2e.ts`)

- **auth** — signup → land in the shell; logout; login (+ a bad-password
  path); and signing in ONCE after a signed-out visit to a protected route,
  without the `page.goto("/login")` that would reset the SPA's auth client.
- **add-connection** — the add-connection dialog's three lanes: the curated
  catalog renders its seeded tiles with zero network calls; community search
  (the Meilisearch mirror) surfaces the stub server with its Verified badge
  and gates the install behind its declared secret header; a custom-URL
  server is added on a distinct stub path. The community install then rides
  the full spine — attach → publish (a real eve build compiled from the
  `cn_`-id, secret-bearing connection row) → chat to a streamed reply —
  proving compile/dispatch on the rebuilt connections domain end-to-end.
  Search degradation (`search_unavailable`) is left to unit tests: it would
  need a second control-plane boot without `MEILISEARCH_URL`.
- **connection-health** — the probe/tool-picker journey on a custom-URL
  connection: the fire-and-forget after-create probe lands (green health dot +
  discovered tool count on the card, asserted through a reload poll), the
  detail's health panel shows Healthy with a fresh last-checked stamp, the
  tool picker lists the discovered `save_note` as a checkbox and allow-listing
  it persists `toolAllow`, Test connection re-probes on demand (the probe POST
  returns the fresh DTO with `health: "ok"`), and the connection still
  attaches to an agent. Stops before publish — the build-bearing spine is
  add-connection's job.
- **oauth-connection** — the FULL OAuth broker spine: a custom connection on
  the stub's `/mcp-oauth` is created with `auth:{type:"oauth"}` (via the
  unified create API — the custom-URL dialog has no OAuth lane; catalog
  recipes own the UI entry point), then everything else is UI: before consent
  the row reads **Auth required** and NOTHING dials the server — not the
  create, not the detail (its stale re-probe is suppressed without a grant),
  not even an explicit Test connection, which answers `auth_required` with no
  round trip; Connect from the detail runs real discovery (401 → PRM pointer +
  challenge scope → stub AS metadata) → DCR → PKCE consent in a popup (the
  spec clicks the stub AS's Approve interstitial) → the callback closes the
  popup and the panel flips to Connected. The post-connect probe then lands
  `ok` **only because it carried the broker's token** — against a fixture
  that 401s an unauthenticated handshake, which is what makes the green badge
  mean something (the stub used to leave the handshake open, so the same
  assertion certified a probe that never read the token at all) — and the
  cached tools it discovers fill the tool picker, which no OAuth connection
  could ever do before. Then attach → publish → chat drives the
  `connection_search` choreography and a
  `securenotes__save_note` call whose bearer the stub MCP server validates
  against the stub AS — proving compiled-agent `getToken` →
  `POST /internal/connections/token` → central refresh end to end (the AS
  issues 30 s tokens, below both 60 s expiry margins, so every read
  refreshes). `POST /__expire` then kills every outstanding token and the
  next call still succeeds (only a fresh refresh explains it); finally the
  AS flips to `invalid_grant` — the run surfaces a failed tool call (never a
  hang) and the connection lands `auth_error` with a Reconnect affordance.
- **agent-workflow** (THE acceptance, agents-first) — author a skill (with a
  file attachment) and two MCP connections (one installed through the
  dialog's community-search lane, one custom-URL) in `/context`; **build an
  agent** in `/agents` (persona typed in
  the markdown editor, Balanced preset, both connections + the skill
  attached); **publish** it (the agent is the compile unit — real eve build,
  wait for the ready chip); **chat with it** through the "New chat" agent
  picker and watch the working block stream a live step, collapse to a
  duration summary, and render the final prose; then **delegate**: build a
  form-trigger workflow bound to that agent (instructions typed with a real
  `@trigger.<field>` autocomplete pick), publish it **instantly** (validate +
  snapshot — workflows have no builds), fire it through the header's Run
  popover (the real trigger-dispatch path), and see the run land in Chat with
  the workflow-provenance chip and the **resolved** `@trigger` value in the
  rendered task message.
- **chat-approval** — an agent is equipped with an MCP connection gated
  "Always ask"; a chat run parks on an inline HITL card; responding to it
  resumes the run — exercising `POST /runs/:id/input` through the UI. Then the
  eve 0.31 session surface: the card must name itself a **question** (eve's
  `kind` discriminator survives eve → tailer → SSE → reducer → card, rather
  than being inferred from a tool name); a second parked run is **stopped**
  and must settle as a user decision (neutral notice, *no* `role="alert"`
  anywhere — `turn.cancelled` is never a failure); **Clear context** fires
  straight off the session-actions menu (`POST /sessions/:id/clear`); and
  **Reset session** must ask first, because the retired eve session id can
  never take another message.
- **webhook-trigger** — publish a minimal agent, bind a webhook workflow to
  it, publish (instant), reveal the ingress token ONCE, fire `/t/:token` with
  a plain HTTP POST, and watch the run surface in Chat as a webhook-origin
  session (origin + workflow-provenance chips). Plus a Slack trigger-binding
  UI smoke (routing controls + the connect-a-team nudge).
- **copilot** — the surface-aware copilot on the scripted fake: (1) scaffold a
  whole delegation from a one-liner — setTrigger / setAgent (the seeded
  "General Purpose" agent, resolved from the prompt inventory) /
  setInstructions land as Apply/Dismiss cards, each apply flashes its target
  section and mutates the live editor, then the workflow publishes instantly
  and runs; (2) apply-one/dismiss-one on an existing workflow — the dismissal
  never touches the draft and verifiably reaches the model; (3) the agent
  editor surface — a setPersona proposal previews as a diff card and applies
  into the persona editor.
- **invite** — owner invites by email → a brand-new user signs up through the
  redirect and accepts → appears in members.
- **a11y** — axe-core scan of `/login`, `/agents`, `/agents/:id`,
  `/workflows/:id`, `/chat`, `/context`, `/settings`; no serious/critical
  violations.
- **screenshots** — env-gated capture of the eight product screenshots in
  `docs/screenshots/` (`SCREENSHOTS=1`; skipped otherwise — see
  `docs/screenshots/README.md`).

> eve's mock model exposes its **built-in** tools to the top-level model but
> routes **MCP connection** tools behind a `connection_search` sub-agent it
> never delegates to **on its own** — and MCP connections attach lazily
> through that sub-agent, so under the mock a published agent never even
> opens an MCP session to the stub unprompted. Run assertions are therefore
> driven with mock-reachable tools (`todo` for the working-block step,
> `ask_question` for the HITL card) — the same streamed-step and
> `input.requested` code paths, without a real LLM. A `Reply with
> exactly: …` line in the persona/instructions makes the mock's prose
> deterministic. When a spec DOES need a real MCP tool call (oauth-connection
> does), the choreography from `spike/REPORT.md` finding 30 works: an
> explicit `Call the connection_search tool with connection "<slug>" and
> keywords "…"` turn performs discovery, after which the discovered
> `<slug>__<tool>` names are re-advertised to the top-level model on every
> later turn of the same session and can be called by name.

Note on builds: every fresh workspace also auto-publishes its seeded
"General Purpose" agent in the background (a real eve build — content hashes
are workspace-scoped, so it is never cache-shared across workspaces). Specs
that need it (`copilot`, `screenshots`) explicitly wait for its Published
chip; the others simply ignore it.

## Driving helpers (`support/`)

- `flows.ts` — signup/login/workspace seeding (Better Auth REST via the
  browser's session cookie).
- `authoring.ts` — `/context` authoring: skills with attachments, the
  add-connection dialog's community-search install (named after the stub
  server's title — community installs have no name field) + custom-URL
  connections, and `gotoSection` (Chat · Agents · Workflows · Context ·
  Settings).
- `builder.ts` — the agents-first spine: `openNewAgent` / `writePersona` /
  `setAgentModelPreset` / `attachAgentResource` / `setAgentConnectionApproval`
  / `publishAgentAndWaitReady` (real build) / `waitForAgentPublished` (seeded
  auto-publish); the workflow editor (`openNewWorkflow`, trigger setters,
  `selectWorkflowAgent`, instructions helpers, `publishWorkflow` — instant,
  `runWorkflowFromHeader`, `revealWebhookToken`); and `startChatAndSend`
  (the "New chat" **agent picker**).
- `copilot.ts` — dock driving + section-flash/rail-card locators.
- `copilot-script.ts` — the keyed fake-LLM conversations (`COPILOT_FAKE_SCRIPT`).

All selectors are role-based with accessible names — the specs double as an
accessibility contract for the surfaces they drive.

## Running locally

```bash
# once
cd e2e && bunx playwright install chromium

# the whole suite (brings the stack up + down itself)
cd e2e && bunx playwright test --project=acceptance

# a single spec
cd e2e && bunx playwright test agent-workflow --project=acceptance
```

Requires Docker, `mise` (global-setup runs `mise install node`, so the Node
pinned in the repo-root `mise.toml` is auto-installed — run `mise trust` once
per checkout or that step fails), and a warm `~/.npm` (the first real eve build
cold-installs the generated agent's deps).

### Fast iteration

- `E2E_REUSE=1` — if the stack is already serving, skip bring-up and leave it
  running on teardown (re-run specs against a live stack).
- `E2E_FRESH_DB=1` — drop + recreate the product DB (default: reuse it so the
  build cache stays warm across runs).
