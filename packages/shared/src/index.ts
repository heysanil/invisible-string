/**
 * Shared contracts package — single source of truth for:
 * - `TriggerEvent` (the normalized trigger envelope, spec §8)
 * - `WorkflowDefinition` (draft pillar config) + `@reference` parsing
 * - Phase-1 API DTOs (publish, sessions, messages, run SSE frames)
 * - frozen eve NDJSON event shapes (captured live in the Phase-0 spike)
 * - envelope crypto (AES-256-GCM)
 */
export * from "./api";
export * from "./crypto";
export * from "./eve-events";
export * from "./trigger-event";
export * from "./workflow-definition";

export const SHARED_PACKAGE = "@invisible-string/shared";
