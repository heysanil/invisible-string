# Phase-2 E2E (Playwright)

A real Chromium browser drives the **built** SPA against the **full** compose
stack — zero manual steps. `global-setup.ts` brings everything up; the specs
only ever poll real UI state (no arbitrary sleeps); `global-teardown.ts` tears
it all down.

## What runs

The global setup (in order):

1. `docker compose -p p2e2e up` — postgres, minio, dex (ports offset from the
   dev `:5432/:9000/:5556` and phase-1 `:5443` stacks, so all three coexist).
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
(`EVE_MOCK_AUTHORED_MODELS`) so no provider key is ever needed.

## Specs (`specs/*.e2e.ts`)

- **auth** — signup → land in the shell; logout; login (+ a bad-password path).
- **workflow-form** (THE acceptance) — author a skill (with a file attachment)
  and two MCP connections (one via the registry browser, one custom-URL) in
  `/context`, build a form-trigger workflow (2 fields, both connections + the
  skill attached, balanced agent, instructions typed with a real `@trigger.*`
  autocomplete pick), **publish** (real eve build, wait for the ready chip),
  then start a chat session and watch the working block stream a live step,
  collapse to a duration summary, and render the final prose.
- **chat-approval** — a run parks on an inline HITL card; responding to it
  resumes the run — exercising `POST /runs/:id/input` through the UI.
- **a11y** — axe-core scan of `/login`, `/workflows/:id`, `/chat`, `/context`,
  `/settings`; no serious/critical violations.

> eve's mock model exposes its **built-in** tools to the top-level model but
> routes **MCP connection** tools behind a `connection_search` sub-agent it
> never delegates to. The published agent genuinely connects to both MCP
> servers (the stub logs the `initialize`/`tools/list` handshakes), but the run
> assertions are driven with mock-reachable tools (`todo` for the working-block
> step, `ask_question` for the HITL card) — the same streamed-step and
> `input.requested` code paths, without a real LLM.

## Running locally

```bash
# once
cd e2e && bunx playwright install chromium

# the whole suite (brings the stack up + down itself)
cd e2e && bunx playwright test --project=acceptance

# a single spec
cd e2e && bunx playwright test workflow-form --project=acceptance
```

Requires Docker, `mise` (Node 24 is auto-installed), and a warm `~/.npm`
(the first real eve build cold-installs the generated agent's deps).

### Fast iteration

- `E2E_REUSE=1` — if the stack is already serving, skip bring-up and leave it
  running on teardown (re-run specs against a live stack).
- `E2E_FRESH_DB=1` — drop + recreate the product DB (default: reuse it so the
  build cache stays warm across runs).

## Observed timings

Two consecutive full green runs (M-series, warm npm cache), each with a full
compose bring-up + teardown:

| run | result | wall clock |
|-----|--------|-----------|
| 1   | 5 passed | ~64 s |
| 2   | 5 passed | ~63 s |
