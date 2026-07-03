/**
 * Worker — placeholder skeleton.
 *
 * Phase 1 adds the supervisor v1: register/heartbeat, ensure-agent(hash) →
 * pull/extract artifact → `PORT=p eve start`, reverse proxy forwarding BOTH
 * `/eve/` and `/.well-known/workflow/`, and the 15-minute idle reaper.
 * Note: compiled eve agents require Node 24.x; the worker image provides it.
 */
export const WORKER_NAME = "invisible-string-worker";

export function workerPlaceholder(): string {
  return WORKER_NAME;
}

if (import.meta.main) {
  console.log(`${WORKER_NAME}: supervisor lands in Phase 1`);
}
