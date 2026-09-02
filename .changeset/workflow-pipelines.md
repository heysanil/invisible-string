---
"@invisible-string/control-plane": minor
"@invisible-string/db": minor
"@invisible-string/shared": minor
"@invisible-string/web": minor
---

**Breaking:** Rebuild workflows as control-plane-interpreted pipelines (TRIGGER → STEPS) — a v2-only config with `tool`/`infer`/`agent` steps plus `for_each`/`branch`/`filter`/`state`, a `run_steps` execution ledger with replay-based crash recovery and per-workflow durable state, agent steps dispatched as `mode:"task"` child runs with structured output, explicit `onComplete.slackReply` delivery, `pipeline.*` run-stream events, new run/steps/state/step-test routes, granular copilot step tools with connection-tool lookup, and no v1 compatibility (the `renderTaskMessage` dispatch path is removed and old-shape drafts require a stack reset).
