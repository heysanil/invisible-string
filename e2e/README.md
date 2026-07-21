# Browser E2E (Playwright)

A real Chromium browser drives the **built** SPA against the **full** compose
stack — zero manual steps. `global-setup.ts` brings everything up; the specs
only ever poll real UI state (no arbitrary sleeps); `global-teardown.ts` tears
it all down.

## What runs

The global setup (in order):

1. `docker compose -p p2e2e up` — postgres, garage, dex (ports offset from the
   dev `:5432/:3900/:5556` and phase-1 `:5443` stacks, so all three coexist).
2. Fresh product DB + migrations + demo seed (`scripts/db-setup.ts`, under Bun).
3. Production `vite build` of the SPA with `VITE_API_URL` baked at the
   control-plane origin.
4. Managed processes with readiness gates: **stub server** (a real MCP server
   on the official SDK + the MCP-registry REST API), **control-plane**,
   **worker**, **vite preview**. Node 24 (mise) is pinned first on the
   control-plane/worker PATH so the real `eve build` and agent boot never fall
   through to a system Node.

Everything except the LLM is real: Better Auth, the compiler, a real
`eve build`, the worker + a real compiled agent, and eve's built-in mock model
(`EVE_MOCK_AUTHORED_MODELS`) so no provider key is ever needed. The copilot
runs on a deterministic scripted fake (`COPILOT_FAKE_SCRIPT` — see
`support/copilot-script.ts`).

## Specs (`specs/*.e2e.ts`)

- **auth** — signup → land in the shell; logout; login (+ a bad-password path).
- **agent-workflow** (THE acceptance, agents-first) — author a skill (with a
  file attachment) and two MCP connections (one via the registry browser, one
  custom-URL) in `/context`; **build an agent** in `/agents` (persona typed in
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
  resumes the run — exercising `POST /runs/:id/input` through the UI.
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
> never delegates to. A published agent genuinely connects to its MCP servers
> (the stub logs the `initialize`/`tools/list` handshakes), but run
> assertions are driven with mock-reachable tools (`todo` for the
> working-block step, `ask_question` for the HITL card) — the same
> streamed-step and `input.requested` code paths, without a real LLM. A
> `Reply with exactly: …` line in the persona/instructions makes the mock's
> prose deterministic.

Note on builds: every fresh workspace also auto-publishes its seeded
"General Purpose" agent in the background (a real eve build — content hashes
are workspace-scoped, so it is never cache-shared across workspaces). Specs
that need it (`copilot`, `screenshots`) explicitly wait for its Published
chip; the others simply ignore it.

## Driving helpers (`support/`)

- `flows.ts` — signup/login/workspace seeding (Better Auth REST via the
  browser's session cookie).
- `authoring.ts` — `/context` authoring: skills with attachments, registry +
  custom-URL MCP connections, and `gotoSection` (Chat · Agents · Workflows ·
  Context · Settings).
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

Requires Docker, `mise` (Node 24 is auto-installed), and a warm `~/.npm`
(the first real eve build cold-installs the generated agent's deps).

### Fast iteration

- `E2E_REUSE=1` — if the stack is already serving, skip bring-up and leave it
  running on teardown (re-run specs against a live stack).
- `E2E_FRESH_DB=1` — drop + recreate the product DB (default: reuse it so the
  build cache stays warm across runs).
