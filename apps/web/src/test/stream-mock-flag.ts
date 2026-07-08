/**
 * Cross-file switch for chat-container.test.tsx's `useThreadStreams` module
 * mock. bun's `mock.module` can keep intercepting the hook's path for every
 * LATER test file in the process (registry-state dependent, and file order is
 * filesystem readdir order — it differs per CI runner; see test/auth-mock.ts
 * for the same trap on the auth client).
 *
 * The mock therefore defaults to its fake (`active: true`) so consumer tests
 * behave identically regardless of file order, and delegates to the REAL
 * implementation only while `use-thread-streams.test.tsx` — the suite that
 * exists to test the real hook — flips this off. The real hook must never
 * run in other component tests via the mocked path: with no control plane
 * listening, its real `streamRun` reconnect backoff enqueues happy-dom tasks
 * forever and the file-boundary `GlobalRegistrator.unregister()` await hangs
 * the whole bun process (observed on Namespace CI runners, 2026-07-08).
 */
export const streamsMockFlag = { active: true };
