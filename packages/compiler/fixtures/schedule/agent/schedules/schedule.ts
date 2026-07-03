import { defineSchedule } from "eve/schedules";

/**
 * schedule trigger (cron "0 9 * * 1-5", evaluated in UTC). Task mode:
 * fire-and-forget prompt; the session runs to completion and cannot park
 * for approvals or OAuth.
 */
export default defineSchedule({
  cron: "0 9 * * 1-5",
  markdown: "Scheduled run of workflow \"daily-digest\". Carry out your standing instructions now. If they require reporting somewhere, use your tools; otherwise summarize the outcome.",
});
