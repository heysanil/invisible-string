/**
 * Safety caps v1 (docs/PLAN.md Phase 1 task 6).
 *
 * - Per-workspace concurrent-run cap: checked at session/message creation;
 *   exceeding it is a typed 429. A run is "active" while queued/running/
 *   waiting (parked approvals hold a slot on purpose — a parked run still
 *   owns eve-side resources).
 * - Per-run wall-clock cap: enforced by the tailer manager (runs/tailer.ts),
 *   which fails the run and stops tailing when MAX_RUN_WALL_CLOCK_MS elapses.
 */
import { and, count, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import type { Db } from "../db";
import { errors } from "./errors";

/** Run statuses that hold a concurrency slot. */
export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting"] as const;

export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];

/** Pure cap decision — true when starting one more run would exceed the cap. */
export function wouldExceedRunCap(activeRunCount: number, cap: number): boolean {
  return activeRunCount + 1 > cap;
}

/** Count the workspace's active runs (join through agent_sessions ownership). */
export async function countActiveRuns(
  db: Db,
  organizationId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(schema.runs)
    .innerJoin(
      schema.agentSessions,
      eq(schema.runs.agentSessionId, schema.agentSessions.id),
    )
    .where(
      and(
        eq(schema.agentSessions.organizationId, organizationId),
        inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );
  return rows[0]?.value ?? 0;
}

/** Throws the typed 429 when the workspace is at its concurrent-run cap. */
export async function assertUnderRunCap(
  db: Db,
  organizationId: string,
  cap: number,
): Promise<void> {
  const active = await countActiveRuns(db, organizationId);
  if (wouldExceedRunCap(active, cap)) {
    throw errors.workspaceRunCapExceeded(cap);
  }
}
