/**
 * Test bootstrap: registers a happy-dom global environment for DOM test files
 * and restores the real globals when each file finishes. Copied from
 * apps/web/src/test/setup.ts — same rationale, same per-file lifecycle.
 *
 * Import this FIRST in every DOM test file (module evaluation order guarantees
 * registration happens before react-dom / testing-library are evaluated), then
 * call `ensureDomForThisFile()` at the top level of the file. Because `bun test`
 * runs every test file in ONE process, leaving happy-dom registered would
 * replace fetch/Request/Headers for every LATER test file too — so each DOM
 * file re-registers in its own beforeAll and unregisters in its afterAll.
 */
import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Module evaluation (first DOM test file in the process): register before
// react-dom is evaluated.
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Per-file happy-dom lifecycle. A shared module is evaluated once per process,
 * so the hooks cannot live at module scope (they would attach only to the first
 * importing file) — every DOM test file calls this at its top level to bind
 * registration to ITS OWN before/after hooks.
 */
export function ensureDomForThisFile(): void {
  beforeAll(() => {
    if (!GlobalRegistrator.isRegistered) {
      GlobalRegistrator.register();
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    // React 19's scheduler drives concurrent work through a MessageChannel; a
    // task can still be queued when a test file ends. Drain the macrotask queue
    // while `window` still exists before tearing the DOM down.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  });
}
