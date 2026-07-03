import { expect, test } from "bun:test";

import { SHARED_PACKAGE } from "./index";

test("shared package exports its name", () => {
  expect(SHARED_PACKAGE).toBe("@invisible-string/shared");
});
