/**
 * DECREED executor interfaces for the pipeline interpreter (workflow-pipelines
 * plan, amendment A2) — created in the Contracts phase so concurrent agents
 * agree without coordination. Executors under `pipeline/steps/` implement
 * {@link StepExecutor}; the runner imports them by kind and is the ONLY thing
 * that calls them. Only the runner-core agent may adjust this file, and must
 * keep executor signatures compatible.
 *
 * Template rendering and condition evaluation are PURE functions in
 * `@invisible-string/shared` (pipeline-template.ts) — the runner calls them;
 * executors receive the already-rendered `input` and never re-render.
 */
import type {
  Logger,
  MasterKey,
  PipelineScope,
  PipelineStep,
} from "@invisible-string/shared";

import type { Db } from "../db";
import type { TokenLifecycleDeps } from "../oauth/tokens";
import type { RuntimeDeps } from "../runtime/routes";

/**
 * The resolution scope for one pipeline run — re-exported VERBATIM from the
 * shared package (pipeline-template.ts owns the shape; `resolveScopePath` and
 * friends consume it). One type, not two in lockstep.
 */
export type { PipelineScope };

/**
 * The runtime deps executors may reach for — a NARROW structural slice of
 * `RuntimeDeps` (runtime/routes.ts satisfies it as-is where fields overlap).
 * Deliberately minimal per A2; the runner-core agent may widen it (the
 * `agent` step in particular needs the dispatch machinery), but executors
 * must keep narrowing: take what you use, nothing more.
 */
export interface PipelineExecutorDeps {
  db: Db;
  /** Structured, redaction-safe logger — never console.* in executors. */
  logger: Logger;
  /**
   * AES-256-GCM envelope master key — tool steps decrypt connection auth
   * headers with it. Absent (unconfigured dev stack) ⇒ credentialed tool
   * steps fail with a typed error, never a crash.
   */
  masterKey: MasterKey | undefined;
  /**
   * Guarded egress fetch (net/guarded-fetch.ts) — EVERY caller-influenced
   * outbound dial (tool-step MCP calls) rides it, same stance as the probe
   * and the OAuth broker.
   */
  fetchImpl: typeof fetch;
  /**
   * OAuth broker token lifecycle (oauth/tokens.ts) — tool steps on `oauth`
   * connections fetch live access tokens through it. Optional exactly like
   * `RuntimeDeps.oauthTokens`: unwired ⇒ those steps fail
   * `oauth_not_connected`-shaped, never boot-fatal.
   */
  oauthTokens?: TokenLifecycleDeps;
  /**
   * Platform provider credentials for `infer` steps — the stack's env RECORD
   * fields, never a `process.env` read (session-title.ts documents why: an
   * ambient key would turn offline test runs into billable traffic).
   * Structurally satisfied by the runtime config's `TitleProviderKeys` slice.
   */
  providerKeys?: {
    openrouterApiKey?: string;
    anthropicApiKey?: string;
    /** OPENROUTER_BASE_URL override (harnesses point this at a stub). */
    openrouterBaseUrl?: string;
  };
  /**
   * The FULL runtime dependency graph, for the one executor that dispatches
   * real work: the `agent` step spawns a child run through the ordinary
   * dispatch machinery (scheduler → ensure-agent → eve session → tailer) and
   * needs everything `dispatchRenderedRun` needs. Optional so tool/infer unit
   * fixtures never build it — those executors must not reach for it.
   * (Type-only import; erased at runtime, so no module cycle.)
   */
  runtimeDeps?: RuntimeDeps;
}

/** Everything one step-instance attempt executes against. */
export interface StepExecuteContext {
  deps: PipelineExecutorDeps;
  /** Workspace scope — executors verify row ownership against it. */
  orgId: string;
  run: {
    /** The parent pipeline `runs` row id. */
    id: string;
    workflowId: string;
  };
  /** The config step being executed (the runner resolved the instance). */
  step: PipelineStep;
  /**
   * The rendered input snapshot (refs already resolved against `scope`) —
   * exactly what the runner persisted to `run_steps.input`. The template
   * scope cannot reach credentials, so neither can this.
   */
  input: unknown;
  /** The run scope as of this step (read-only to executors). */
  scope: PipelineScope;
  /** Cooperative cancellation — aborted between/inside attempts. */
  signal: AbortSignal;
  /** 1-based attempt counter (the runner owns retry policy + backoff). */
  attempt: number;
  /**
   * This step INSTANCE's ledger path (`st_a`, `st_loop/3/st_b`) — the
   * `run_steps` claim key the runner already holds for this attempt.
   * Diagnostics/idempotency-key material for executors; never re-claim it.
   */
  path: string;
  /**
   * An already-linked child run to RE-ATTACH to instead of dispatching a new
   * one — set by the runner when the ledger row carries a `child_run_id`
   * (crash recovery, or resuming after the child's `waiting` park settled).
   * Only the `agent` executor sees a value here.
   */
  childRunId?: string;
}

/**
 * What one attempt produced. `failed.retryable` is the EXECUTOR's
 * classification (e.g. `unreachable` yes, `tool_error`/`invalid_args` no);
 * the runner combines it with per-kind attempt budgets. `waiting` is the
 * `agent` step parking on a child run that parked — the parent step and run
 * park with it, and `POST /runs/:id/input` on the child resumes the chain.
 */
export type StepOutcome =
  | { status: "succeeded"; output: Record<string, unknown> }
  | {
      status: "failed";
      /** Stable machine class — feeds `run_steps.error_class` + events. */
      errorClass: string;
      /** Human-readable, SCRUBBED (probe `scrubSecrets` discipline). */
      error: string;
      retryable: boolean;
    }
  | { status: "waiting"; childRunId: string };

/** One step kind's executor — pure I/O against the context, no ledger writes. */
export type StepExecutor = (ctx: StepExecuteContext) => Promise<StepOutcome>;
