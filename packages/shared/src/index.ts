import { z } from "zod";

/**
 * Shared contracts package — placeholder.
 *
 * Phase 1 adds: TriggerEvent, pillar-config schemas, frozen eve event types
 * (captured from live runs in the Phase 0 spike), and API contracts.
 */
export const SHARED_PACKAGE = "@invisible-string/shared";

export const placeholderSchema = z.object({
  ok: z.literal(true),
});

export type Placeholder = z.infer<typeof placeholderSchema>;
