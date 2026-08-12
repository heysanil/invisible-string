/**
 * Shared contracts package — single source of truth for:
 * - `AgentDefinition` (the agent draft — the compile unit)
 * - `WorkflowConfig` (trigger → agent → instructions) + `@reference` parsing
 * - `TriggerEvent` (the normalized trigger envelope, storage/provenance only)
 * - task-message rendering (`renderTaskMessage` — what agents receive)
 * - API DTOs (agents, publish, sessions, messages + context controls, run SSE
 *   frames, Phase-3 trigger ingress / integrations / trigger bindings / run
 *   cancel)
 * - per-source trigger mappers (Slack / form → TriggerEvent data)
 * - worker-plane identity contract (per-worker tokens / mTLS)
 * - observability contract (structured logs + /internal/metrics)
 * - frozen eve NDJSON event shapes (captured live against eve@0.31.3)
 * - the eve session API v2 wire contract (ID-addressed routes, send XOR
 *   respond, cancel/clear/compact/reset, stream query + tail index)
 * - envelope crypto (AES-256-GCM)
 * - tool-call display resolution (qualified-name split + probe-cached metadata)
 */
export * from "./agent-definition";
export * from "./api";
export * from "./connector-catalog";
export * from "./copilot";
export * from "./crypto";
export * from "./eve-events";
export * from "./eve-session-api";
export * from "./id";
export * from "./observability";
export * from "./render";
export * from "./tool-display";
export * from "./trigger-adapters";
export * from "./trigger-event";
export * from "./worker-identity";
export * from "./worker-token-crypto";
export * from "./workflow-config";

export const SHARED_PACKAGE = "@invisible-string/shared";
