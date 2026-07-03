import { expect, test } from "bun:test";

import { placeholderSchema } from "./index";

test("placeholder schema parses", () => {
  expect(placeholderSchema.safeParse({ ok: true }).success).toBe(true);
  expect(placeholderSchema.safeParse({ ok: false }).success).toBe(false);
});
