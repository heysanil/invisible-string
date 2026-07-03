import { expect, test } from "bun:test";

import { compilerPlaceholder } from "./index";

test("compiler links against the shared workspace package", () => {
  expect(compilerPlaceholder()).toEqual({
    dependsOn: "@invisible-string/shared",
    valid: true,
  });
});
