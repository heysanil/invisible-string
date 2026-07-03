import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/**
 * Approval-gated custom tool (HITL): every call parks the session at
 * input.requested / session.waiting until a human approves. Runs in the app
 * runtime (not the sandbox) and appends the note to
 * $SPIKE_MARKER_DIR/notes.log so tests can assert the side effect really
 * executed after a kill/restart resume.
 */
export default defineTool({
  description:
    "Record a note durably. Requires human approval before every call.",
  inputSchema: z.object({ note: z.string().min(1) }),
  approval: always(),
  async execute({ note }) {
    const dir = process.env.SPIKE_MARKER_DIR;
    if (dir === undefined || dir.length === 0) {
      return { ok: false, reason: "SPIKE_MARKER_DIR unset" };
    }
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "notes.log"), `${note}\n`);
    return { ok: true, recorded: note };
  },
});
