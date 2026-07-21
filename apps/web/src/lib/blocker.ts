/**
 * Parse a control-plane 409 "in use" error into the list of entity names
 * that block the action. For MCP connections the blocking entities are
 * AGENTS (the server's `connection_in_use` details carry the agent names
 * whose draft or published context references the connection — see
 * apps/control-plane/src/resources/mcp-connections.ts connectionReferences).
 * The server sends a bare name array; we also read a couple of legacy keyed
 * shapes defensively so a small contract drift degrades to an empty list,
 * never a crash.
 */
import { z } from "zod";

import { ApiError } from "./api-client";

/** Machine codes the server uses for "still referenced, cannot delete". */
export const IN_USE_ERROR_CODES = new Set([
  "connection_in_use",
  "resource_in_use",
  "skill_in_use",
  "conflict",
]);

const nameArray = z.array(z.string().min(1));
const objArray = z.array(z.object({ name: z.string().min(1) }));

const detailsSchema = z.union([
  nameArray,
  objArray,
  // Legacy keyed shapes (pre-agents-first servers) — kept for defensiveness.
  z.object({ workflows: z.union([nameArray, objArray]) }),
  z.object({ workflowNames: nameArray }),
]);

function toNames(value: z.infer<typeof detailsSchema>): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry : entry.name));
  }
  if ("workflowNames" in value) return value.workflowNames;
  const inner = value.workflows;
  return inner.map((entry) => (typeof entry === "string" ? entry : entry.name));
}

export interface BlockingReference {
  code: string;
  /** Names of the entities that still reference the resource (agents today). */
  blockingNames: string[];
}

/**
 * Returns the blocking reference when `error` is a 409/in-use failure, else
 * null. `blockingNames` may be empty if the server sent no detail — callers
 * still show the generic blocker copy.
 */
export function parseBlockingReference(error: unknown): BlockingReference | null {
  if (!(error instanceof ApiError)) return null;
  const isConflict = error.status === 409 || IN_USE_ERROR_CODES.has(error.code);
  if (!isConflict) return null;
  const parsed = detailsSchema.safeParse(error.details);
  return {
    code: error.code,
    blockingNames: parsed.success ? toNames(parsed.data) : [],
  };
}
