/**
 * Parse a control-plane 409 "in use" error into the list of workflow names
 * that block the action (e.g. deleting an MCP connection referenced by
 * published workflows). The server carries them in the error `details`; we
 * read them defensively across a couple of plausible shapes so a small
 * contract drift degrades to an empty list, never a crash.
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
  workflowNames: string[];
}

/**
 * Returns the blocking reference when `error` is a 409/in-use failure, else
 * null. `workflowNames` may be empty if the server sent no detail — callers
 * still show the generic blocker copy.
 */
export function parseBlockingReference(error: unknown): BlockingReference | null {
  if (!(error instanceof ApiError)) return null;
  const isConflict = error.status === 409 || IN_USE_ERROR_CODES.has(error.code);
  if (!isConflict) return null;
  const parsed = detailsSchema.safeParse(error.details);
  return {
    code: error.code,
    workflowNames: parsed.success ? toNames(parsed.data) : [],
  };
}
