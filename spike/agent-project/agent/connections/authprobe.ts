import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineMcpClientConnection } from "eve/connections";

/**
 * Auth-probe connection for the mid-run authorization spike
 * (spike/tests/authorization-events.test.ts). Mirrors the platform's
 * broker-delivered shape: a getToken-only (non-interactive) `auth` whose
 * token the MCP server may start rejecting mid-session, and whose mint can
 * itself fail (the compiled `platformConnectionToken` throws a plain Error
 * on a non-200 from the control plane).
 *
 * Two facts shape the knobs (spike/REPORT.md finding 30):
 * - The `url` is resolved ONCE at `eve build` and BAKED into the compiled
 *   manifest embedded in `.output/server/index.mjs`; the runtime connects to
 *   the manifest value, so a runtime env override of the url is silently
 *   ignored. The default therefore IS the test stub's fixed port (4102 —
 *   spike block: proxy 4100, agent 4101). SPIKE_AUTH_MCP_URL only matters if
 *   set at BUILD time.
 * - `auth` callbacks are NOT serializable into the manifest — getToken runs
 *   from the bundled module at RUNTIME, so it may read env/filesystem lazily
 *   per call: it throws a PLAIN Error (not
 *   ConnectionAuthorizationRequiredError) while
 *   `<SPIKE_MARKER_DIR>/authprobe-token-throw` exists, which lets the test
 *   flip the mode mid-session without a rebuild or restart, and keeps the
 *   keyless `eve build` from ever evaluating it.
 */
export default defineMcpClientConnection({
  url: process.env.SPIKE_AUTH_MCP_URL ?? "http://127.0.0.1:4102/mcp",
  description:
    "Auth-probe notes stub: saves short notes. Spike fixture for mid-run token rejection.",
  auth: {
    getToken: async () => {
      const markerDir = process.env.SPIKE_MARKER_DIR;
      if (
        markerDir !== undefined &&
        existsSync(join(markerDir, "authprobe-token-throw"))
      ) {
        throw new Error(
          "spike-authprobe-token-mint-failed (deliberate plain-Error throw, mirrors platformConnectionToken on a non-200)",
        );
      }
      return { token: "spike-static-token" };
    },
  },
});
