import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { defineSchedule } from "eve/schedules";

/**
 * Every-minute schedule in handler form. It needs no model call: the handler
 * appends a marker line so tests can prove Nitro's scheduled-task runner
 * actually fires under `eve start` (schedules never fire under `eve dev`).
 */
export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const dir = process.env.SPIKE_MARKER_DIR;
    if (dir === undefined || dir.length === 0) return;
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "heartbeat.log"), `${new Date().toISOString()}\n`);
  },
});
