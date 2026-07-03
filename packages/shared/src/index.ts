/**
 * Shared contracts package — single source of truth for:
 * - `TriggerEvent` (the normalized trigger envelope, spec §8)
 * - `WorkflowDefinition` (draft pillar config) + `@reference` parsing
 * - API DTOs (publish, sessions, messages, run SSE frames, Phase-3 trigger
 *   ingress / integrations / trigger bindings / run cancel)
 * - per-source trigger mappers (Slack / form → TriggerEvent data)
 * - worker-plane identity contract (per-worker tokens / mTLS)
 * - observability contract (structured logs + /internal/metrics)
 * - frozen eve NDJSON event shapes (captured live in the Phase-0 spike)
 * - envelope crypto (AES-256-GCM)
 */
export * from "./api";
export * from "./crypto";
export * from "./eve-events";
export * from "./observability";
export * from "./trigger-adapters";
export * from "./trigger-event";
export * from "./worker-identity";
export * from "./worker-token-crypto";
export * from "./workflow-definition";

export const SHARED_PACKAGE = "@invisible-string/shared";
