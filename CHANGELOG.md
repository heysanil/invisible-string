# Changelog

All notable changes to this project, newest first.

Entries from `v0.3.0` onward are written at merge time as
[changesets](https://changesets.dev) — see the **Releases** section of
`AGENTS.md`. Entries for `v0.2.0` and earlier are a **historical
reconstruction** from the conventional-commit log between tags, not authored
release notes.

## v0.8.0 — 2026-09-02

### Breaking changes
- **web** — Replace the workflow memo editor with the conversational-first pipeline shell — a copilot ComposerPane beside a TriggerCard + PipelineStrip pane with inline step inspectors, ghost proposals, per-step tests, a run overlay, and a linkable Runs tab (run history plus a live step timeline with drawers that embed agent-step child-run transcripts).
- **control-plane, db, shared, web** — Rebuild workflows as control-plane-interpreted pipelines (TRIGGER → STEPS) — a v2-only config with `tool`/`infer`/`agent` steps plus `for_each`/`branch`/`filter`/`state`, a `run_steps` execution ledger with replay-based crash recovery and per-workflow durable state, agent steps dispatched as `mode:"task"` child runs with structured output, explicit `onComplete.slackReply` delivery, `pipeline.*` run-stream events, new run/steps/state/step-test routes, granular copilot step tools with connection-tool lookup, and no v1 compatibility (the `renderTaskMessage` dispatch path is removed and old-shape drafts require a stack reset).

### Features
- **control-plane, db, shared, web** — Make MCP OAuth connections actually work: the health probe now presents the broker's access token through `getAccessToken` instead of dialling unauthenticated and reporting the server's correct 401 as a rejected credential (so OAuth connections finally populate their tool cache), an oauth row is no longer probed before consent, `hasCredentials` follows the grant rather than the auth type, discovery is scheme/issuer/resource-validated with challenge-first scopes and `offline_access`, only `invalid_grant` retires a grant while a declined or abandoned re-consent leaves a live one untouched, consent results post to the SPA origin (new optional `PUBLIC_WEB_URL`, defaulting to `PUBLIC_APP_URL`) carrying a sanitized failure reason each surface explains in the same words, pending flows are bound to the user who started them, and catalog OAuth presets now declare their client-identity strategy — adding an operator-configured pre-registered client mode (`MCP_OAUTH_<PREFIX>_CLIENT_ID`) and removing the Vercel preset, whose authorization server rejects dynamic registration outright.
- **control-plane, web** — Harden the MCP OAuth broker after review: provider `error` strings are narrowed to a closed RFC vocabulary before they can reach `last_error` or a DTO (an authorization server could otherwise echo back the refresh token, authorization code or client secret it had just received), the consent callback's promotion and failure bookkeeping are guarded by an optimistic-concurrency stamp so a flow that loses its race to a URL or auth-mode change discards its tokens instead of resurrecting a stale grant, `MCP_OAUTH_<PREFIX>_ISSUER` is now required and exact-matched with no fail-open, a stored dynamic-registration client whose issuer was never recorded is re-registered rather than replayed at a new authorization server, and permanently-dead refreshes (`invalid_client`, `unauthorized_client`, `invalid_scope`, `unsupported_grant_type`) retire the grant as `auth_required` instead of being retried forever as transient.
- **control-plane, db** — Stage an MCP OAuth consent flow's discovered endpoints and client identity on the new `connection_oauth.pending_flow` column and promote them onto the grant only when a token exchange succeeds, so a re-consent that is declined, abandoned, or rejected can no longer repoint a live grant's token and revocation endpoints at an authorization server the MCP server nominated mid-life.

### Fixes & maintenance
- **control-plane, db** — Confirm a Stop's remote cancel from eve's own stream: `runs.turn_id` is the only acceptance proof (written when the tail attributes the run's own `turn.started`, in send order), the live tail sends a turn-qualified cancel or nothing and stays on the stream in observation mode until the run's own turn boundary, a session-terminal answer, or a newer run's `turn_id` clears `remote_cancel_pending_at` (never eve's 202 to a pre-turn cancel, never a synthesized `running` successor or leftover events), the no-tail settlement, the periodic sweep and boot reconciliation re-open observation instead of chasing eve unqualified, and an obligation unconfirmed past `REMOTE_CANCEL_OBSERVE_MS` (default 10 min) is declared unresolved on the row (`remote_cancel_unresolved_at`, migration 0017) rather than silently cleared.
- **control-plane** — Await the reply-delivery ledger's failure settle instead of returning its promise, so a settle write that rejects during shutdown surfaces as a logged delivery failure rather than an unhandled rejection in the control-plane process.
- **control-plane** — Close five read-then-act ordering windows in dispatch and recovery: a replayed `for_each` failure verdict is now authoritative over the fresh resolution's shape (a recorded `fan_out_exceeded` is never reported as `items_not_array`), every eve dispatch path persists the eve session id BEFORE its post-eve terminal recheck so a Stop racing the create always finds an id to remote-cancel (the fresh-chat and post-reset create routes gain the same recheck), the session-busy predicate counts a canceled run whose dispatch may still be in flight on an eveless session (transient `session_busy` instead of a second eve session), the post-eve abandon skips its unqualified session-level cancel when a newer run already owns the session, and boot reconciliation's eveless-session close is an atomic guarded UPDATE that leaves a session untouched if it gained its eve id between snapshot and close.
- **control-plane** — Close three dispatch/recovery crash windows: a crashed `for_each` now replays its RECORDED resolution verdict (a doomed over-`maxItems`/non-array loop fails `fan_out_exceeded`/`items_not_array` on recovery instead of re-resolving against moved state and executing), the dispatch-attempt marker (`runs.started_at`) alone is now the recovery authority (boot reconciliation never tails a marker-null run, every chat/agent dispatch arms it pre-send, and a stillborn `session:"thread"` continuation is safely re-sent into its established session), and a Stop racing an in-flight eve create is handled at the source (the dispatch re-reads the child run after the create returns and remote-cancels with the fresh session id, the Slack thread-claim eviction spares marker-armed possibly-mid-dispatch holders, and boot reconciliation closes abandoned eveless marker-set sessions to free their thread claims).
- **control-plane** — Move the pipeline runner's per-run driver lock onto a dedicated, bounded lock pool (`DB_PIPELINE_LOCK_POOL_SIZE`, default 32; exhaustion is the typed transient skip `lock_pool_exhausted` taken before any run row exists — 503 `pipeline_lock_pool_exhausted` on webhook/manual ingress — instead of pinning root-pool connections until ten long pipelines wedged the whole control plane), clear a Stop's durable remote-cancel obligation only on a confirmed outcome (eve acknowledged, eve `session_not_active`, superseded, or nothing to chase — a transport failure now retains `remote_cancel_pending_at`, and a live-tail cancel that fails in transport records it exactly like a skipped one), make the deferred cancel chase back off across a saturated lock pool for its whole bound, and add a periodic advisory-locked remote-cancel sweep (`REMOTE_CANCEL_SWEEP_MS`, default 60 s) so a healthy process finishes those obligations without a restart.
- **control-plane** — Close four run-lifecycle defects: a live-tail Stop whose remote cancel was skipped or failed in transport now writes its durable `remote_cancel_pending_at` obligation inside the same CAS that finalizes the row canceled (never a second statement after it), "superseded" now requires a successor that provably reached eve (running/waiting, or terminal with observed events — a merely queued successor retains the marker and the chase retries, in both the guarded cancel and the post-eve recheck), a periodic pipeline-recovery sweep (`PIPELINE_RECOVERY_SWEEP_MS`, default 60 s, replica-elected and lock-gated) re-adopts interrupted pipeline runs left `locked` at boot instead of leaving them active until a restart, and the manual "Run now" route answers the transient 503 `pipeline_lock_pool_exhausted` for a pinned lock pool instead of collapsing it into 409 `run_overlap_skipped`.
- **control-plane** — Serialize each agent session's dispatch decisions under a per-session Postgres advisory lock (held across the eve call and its settlement, released by a crash with its connection): admission, the canceled-dispatch abandon, and the boot sweep's eveless close no longer race as separate read-then-acts — a canceled dispatch's accepted turn is always remote-canceled instead of leaking when a successor slipped in, the unqualified session-level cancel can never land after a successor's turn started (the cancel routes' remote leg is lock-guarded and deferred, never dropped, while a dispatch is in flight), the sweep skips lock-held candidates and its guarded UPDATE atomically re-asserts the ledger, and an eve create that fails after arming the dispatch-attempt marker (a client timeout racing eve's 202 included) closes the still-eveless session on any terminal outcome so the next message mints a fresh session instead of a second live turn beside an unobservable one.
- **control-plane, db** — Close six defects in the per-session dispatch lock: the lock now rides a dedicated Postgres pool (`DB_LOCK_POOL_SIZE`) with a bounded reserve so concurrent dispatches can no longer deadlock the root pool, a fresh session's id is pre-minted so its lock is taken before the claim transaction (a timeout creates nothing) and continuations re-read their session under the lock with CAS-only status writes (no stale-snapshot resurrection of a closed row), a lock-holding dispatch heals an abandoned eveless session inline instead of answering `session_busy` until a restart, a Stop on a live tail awaits its remote cancel under the lock before finalizing the row (a follow-up can no longer be admitted under an airborne unqualified cancel), every no-tail Stop records a durable `runs.remote_cancel_pending_at` obligation (additive migration) that the guarded chase clears and boot reconciliation finishes after a crash, and the HITL resume flips waiting→queued by CAS and re-checks terminality before the continue so a Stop is never erased.
- **control-plane** — Close three in-process serialization races around a session's eve stream: a tail now attributes turns against the session's CURRENT remote-cancel obligations (re-read at every turn opening, boundary, settlement and on the manager's signal) so a continuation Stopped before its own tail started is cancelled turn-qualified and cleared on its boundary instead of being persisted as a foreign turn and aging out unresolved; attribution and settlement run on one per-tail serial queue so a Stop or wall-clock cap landing mid-attribution issues the qualified cancel with the attributed turn id rather than installing a null-id obligation the boundary can never match; and clear/compact/reset hold the session dispatch lock across their quiet check, eve call and drain, so a dispatch can no longer be admitted under a control's drain (a second reader on one stream) or a reset retire a session beneath a just-admitted dispatch (contention answers the transient `session_busy`).
- **control-plane** — Close two ordering races in remote-cancel confirmation: turn attribution now reads a session's claimants (open obligations and live unattributed successors) in ONE store statement so a no-tail Stop committing mid-attribution can no longer leave its already-open turn classified foreign, adoption of an obligation with no turn id looks back over the session's persisted unowned content turns and attributes (and cancels, or meets on a persisted boundary) retroactively, and the tailer manager checks reader liveness at the obligation handoff — an aborted tail leaves the reader slot synchronously, a refused signal makes the settlement open its own observer chained behind the draining cursor, and the context controls' quiet check counts a draining tail as holding the stream.
- **control-plane** — Close two run-tail liveness defects: every exit path out of a tail (its natural terminal and reconnect exhaustion included, not only an explicit abort) now takes one synchronous `close` transition that frees the session's reader slot and refuses obligation handoffs from then on, and a tail chained behind a draining predecessor arms its observation deadline at creation and bounds the wait — a drain that never releases the stream is seized and fenced after `streamTakeoverMs` and its cursor taken over — so a hung reconnect or store call can no longer wedge a session's tail slot until restart.
- **control-plane** — Bound every product-DB statement with a Postgres `statement_timeout` on all three control-plane pools (`DB_STATEMENT_TIMEOUT_MS`, default 30 s) and derive the run tailer's takeover bound from it: a seized tail is now fenced between statements and its successor waits the statement timeout plus a margin — not a second fixed pause — before reading the session's cursor, so a stalled event write that has reached the server is landed or dead before the successor reads (a write still queued client-side behind a root pool starved for longer than the bound is the one documented residual), and a hung drain is seized by the manager after `streamTakeoverMs` and evicted from the stream-holder list after the same derived bound whether or not it ever finishes (capped per session), so a session can no longer answer `session_busy` forever on a drain that never releases.
- **control-plane** — Carry the OAuth end-to-end lessons into pipeline `tool` steps: an oauth connection's grant status is read before any dial (a pending or absent grant fails `auth_required` without touching the server), a grant the authorization server retired fails `auth_error` and is never retried, an unreachable authorization server during refresh is a retryable `unreachable` that leaves the grant connected, and `hasCredentials` reflects the credential actually presented rather than the auth type.
- **control-plane, db** — Attribute eve turns by CONTENT instead of send order: the dispatch-attempt CAS now records `runs.message_hash` (migration 0018 — the sha256 of the exact message sent, never the text; null for a content-less `inputResponses` resume, which eve opens with no `message.received`), the tail holds a `turn.started` until the next event and matches the turn's `message.received` against the session's open obligations (pending before unresolved, oldest first), then its own run, then a live successor — a turn nobody sent is foreign and is never attributed or cancelled, so a never-sent canceled run can no longer steal a successor's turn and get it cancelled unless the two texts are identical (the documented residual); unresolved obligations stay attributable and a late match clears both columns; the wall-clock cap and shutdown settle the row `failed` WITH the remote-cancel obligation and never send an unqualified cancel; clear/compact/reset answer `session_busy` while an observation tail is on the session (one reader per stream); and a `reset` — which retires the eve id — settles every obligation on the row as session-terminal.

## v0.7.0 — 2026-09-01

### Features
- **control-plane** — Make reasoning effort actually reach OpenRouter from the control plane: align the AI SDK pins with the compiler's version matrix (retiring a stale `@openrouter/ai-sdk-provider` alpha that silently dropped every reasoning route), route the effort per provider through the new `model/reasoning.ts`, and add `COPILOT_REASONING_EFFORT` (default off) so the copilot can ask for one too.

### Fixes & maintenance
- **web** — Fix signing in requiring two attempts and workspace content staying blank until a reload, by moving SPA identity off Better Auth's React hooks onto a viewer query gated in the router; the cached query data of a previous account is now dropped whenever the signed-in principal changes, including from another tab, a session revoked elsewhere is noticed on refocus or reconnect, every auth request behind the gate is bounded so a hung server cannot wedge navigation, and accepting a workspace invitation can no longer strand you on a retry that re-reads the invitation it already consumed.

## v0.6.0 — 2026-08-12

### Breaking changes
- **compiler, control-plane, db, design-tokens, shared, site, web** — The agent content hash now keys on the agent's stable id instead of its slugified display name, so every agent rebuilds once on its next publish and duplicate agent names are legal; alongside it, publishing no longer blocks the editor and its build watch follows you across the whole app, the editor separates unsaved from unpublished changes, chat sessions enter instantly and title themselves (falling back to the thread's first message, which the session list now carries), tool calls and a context-budget meter replace raw slugs and build identity in the thread, clearing or compacting the context leaves a divider that survives a reload while a compaction with nothing to summarize says so, and the copilot shows its steps and reasoning, can set an agent's name and description and sees both as the editor currently holds them, can apply edits without the accept gate, and reports an edit that failed to apply as failed.

### Features
- **site** — Bring the marketing/docs site back in sync with everything shipped since the agents-first pivot: a new Chat page covering the run timeline, Stop, the message queue and context controls; reasoning effort documented across Models, Agents and Overview; corrected tool-filter scope on Context & MCP; guarded egress and OAuth token custody on Security; the search index on Architecture and Deploy your own.
- **site** — Flesh out the docs site into a comprehensive reference: expand all seventeen existing pages past their placeholder state, add a Guides section with five task-based walkthroughs and a Reference section with a glossary, limits and defaults, troubleshooting, and keyboard and accessibility notes, and add new Building pages for Skills and Settings.
- **site** — Prerender every landing and docs route to static HTML with per-page title, description, canonical, OG and JSON-LD metadata, and add a generated sitemap.xml, robots.txt and llms.txt, real 404 statuses, a 301 for /docs, and noindex on preview deploys.

## v0.5.0 — 2026-08-11

### Breaking changes
- **control-plane, db, shared, web** — Rebuild the connections domain on new `connections` tables with a curated connector catalog, Meilisearch-mirrored community registry search, and unified create routes replacing the registry install flow.

### Features
- **compiler, control-plane, db, shared, web** — Add the MCP OAuth 2.1 broker: path-aware discovery, CIMD/DCR client identity, PKCE popup consent, envelope-encrypted tokens with single-flight central refresh, an agent-facing token route with audience-derived version binding, oauth codegen via getToken, and OAuth connectors in the catalog.
- **control-plane, web** — Add connection health probes, cached tool discovery with a checkbox tool picker, a connection detail surface with test-connection, and a hardened SSRF-guarded egress path for all caller-influenced control-plane fetches.

## v0.4.0 — 2026-08-10

### Features
- **web** — Move the chat Stop control onto the composer's send button and queue messages typed during a run, merging them into one send when the session frees.
- **web** — Render a run as an ordered timeline of work and speech segments so reasoning accumulates instead of overwriting, interim narration renders in chronological position, and streaming text never relocates after it has rendered.

### Fixes & maintenance
- **worker** — Stop the artifact-cache boot scan from killing worker startup when an entry disappears between readdir and stat.
- **web** — Stub every server-only `packages/shared` module for the browser, fixing the `node:crypto` crash that made the SPA fail to load, and add a guard test so a new server-only module in the shared barrel can no longer break the client bundle silently.
- **web** — Replay a rich-text editor focus request that arrives before the editor instance exists instead of silently dropping it.

## v0.3.0 — 2026-08-09

### Breaking changes
- **compiler, control-plane, shared, web, worker** — Upgrade eve 0.19.0 → 0.31.3. Sessions are now ID-addressed (session API v2), continuation tokens are gone, and stop plus context controls are available. Every published agent must be republished to migrate.
- **compiler, control-plane, db, shared, web** — Reasoning effort is now set per preset and inherited by agents, and the default model set has changed. Existing agents pick up the new defaults on their next publish.

### Features
- **control-plane** — Adopt changesets for releases: merging the `chore(release): version packages` PR now computes the version, writes `CHANGELOG.md`, tags `vX.Y.Z`, cuts the GitHub Release, and builds the GHCR images in one workflow run.
- **web** — Replace the chat markdown renderer with Streamdown, including a streaming caret and E1-themed code blocks.
- **design-tokens, web** — Replace the CodeMirror prompt editors with Tiptap, including the E1 token work the new editor surface needs.

### Fixes & maintenance
- **control-plane** — Align the production images' node with `packages/compiler/versions.json` and add a guard so the two cannot drift.
- **control-plane** — Pin the host toolchain (bun, node, wrangler) in `mise.toml` and install it in every CI job via `mise-action`, so all lanes run the same versions.

## v0.2.0 — 2026-07-21

### Breaking changes
- **agents** — Agents-first re-architecture: first-class agents, agent chat, and workflows that delegate to a bound agent version rather than compiling their own.

## v0.1.8 — 2026-07-09

### Fixes & maintenance
- **worker** — Normalize `WORKER_ID` to lowercase at config parse.

## v0.1.7 — 2026-07-09

### Features
- **site** — Deploy the marketing and docs site to Cloudflare Workers at invisiblestring.io.

### Fixes & maintenance
- **control-plane** — Disable Bun's default idle timeout on the API server, which was cutting quiet SSE run tails and cold-boot chat dispatches.
- **ci** — Add the docs-sentinel documentation audit; invoke wrangler via a pinned npx rather than wrangler-action.

## v0.1.6 — 2026-07-09

### Features
- **site** — Landing page and docs shell on the E1 design system, with messaging pivoted to user outcomes.
- **slack** — Checked-in Slack app manifest, renderer, and setup guide.
- **web** — Replace the triangle logo with a solid spool mark.

### Fixes & maintenance
- **design-tokens** — Extract the E1 tokens out of `apps/web` into `packages/design-tokens`.
- **build** — Resolve Node 24 directly; build steps no longer spawn the mise binary.
- **ci** — Move workflows to Namespace runners.
- **infra** — Copy the `apps/site` manifest into image builds, which a frozen install had broken.
- **site** — Eliminate layout shift from looping vignettes.

## v0.1.5 — 2026-07-08

### Features
- **web** — First-run workspace onboarding and invite acceptance.
- **infra** — Standalone external-data compose, with a CI drift guard.

## v0.1.4 — 2026-07-07

### Features
- **db** — The migrator now creates missing databases, healing volumes initialized without init scripts.

### Fixes & maintenance
- **infra** — Inline the prod compose config files so deploys work without a repo checkout.

## v0.1.3 — 2026-07-07

Initial release: the full platform spine across phases 0–4.

### Features
- **compiler, runtime** — Workflow→eve codegen with golden tests; build service, publish, sessions and runs, NDJSON tailer, SSE, capabilities.
- **worker** — Supervisor with artifact cache, per-agent processes, streaming proxy, and heartbeat; scheduler pool with affinity, failover, drain, and a sandbox reaper.
- **triggers** — Webhook, form, Slack, and schedule ingress; Slack app OAuth; cancellation; dispatch-time allowlisting.
- **web** — Glass shell and E1 theme, auth pages, hybrid workflow builder, chat surface, context and settings sections.
- **copilot** — WebSocket tool loop with validated draft mutations, and a copilot panel with diff-preview suggestion cards.
- **auth, db** — Better Auth with organizations and SSO, envelope crypto, schema, migrations, and seeds.
- **obs** — Structured logging with redaction, a metrics endpoint, deep health, and graceful lifecycle.
- **infra** — Production compose topology, container images for control-plane/worker/web, GHCR publishing on release tags, and a one-command dev orchestrator.

### Fixes & maintenance
- **infra** — Replace MinIO with Garage across the dev stack, every test harness, and all CI lanes.
- **worker** — Hand-pump artifact downloads; `Bun.write(Response)` stalls on Linux.
