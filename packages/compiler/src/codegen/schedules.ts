/**
 * Generated `agent/schedules/schedule.ts` for schedule triggers.
 *
 * Markdown (task-mode) form: eve runs the agent on the prompt on the cron
 * cadence. Two documented constraints (PLAN correction 9 + eve docs):
 * - schedules fire ONLY under `eve start` (Nitro task runner) — never scale
 *   schedule-bearing agents to zero;
 * - task-mode sessions cannot park, so approval-gated tools fail the run
 *   instead of waiting for a human. Builder validation should warn when a
 *   schedule trigger is combined with approval-gated connections.
 */
import { tsString } from "./strings";

export function emitSchedule(cron: string, workflowSlug: string): string {
  const prompt = `Scheduled run of workflow "${workflowSlug}". Carry out your standing instructions now. If they require reporting somewhere, use your tools; otherwise summarize the outcome.`;
  return `import { defineSchedule } from "eve/schedules";

/**
 * schedule trigger (cron ${tsString(cron)}, evaluated in UTC). Task mode:
 * fire-and-forget prompt; the session runs to completion and cannot park
 * for approvals or OAuth.
 */
export default defineSchedule({
  cron: ${tsString(cron)},
  markdown: ${tsString(prompt)},
});
`;
}
