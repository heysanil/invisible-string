/**
 * Test bootstrap: registers a happy-dom global environment exactly once.
 * Import this FIRST in every DOM test file — module evaluation order
 * guarantees it runs before react-dom / testing-library are evaluated.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

declare global {
  var __happyDomRegistered: boolean | undefined;
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

if (!globalThis.__happyDomRegistered) {
  GlobalRegistrator.register();
  globalThis.__happyDomRegistered = true;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export {};
