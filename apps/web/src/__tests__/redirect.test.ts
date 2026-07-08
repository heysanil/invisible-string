import { expect, test } from "bun:test";

import { safeRedirectPath } from "../lib/redirect";

test("accepts same-app absolute paths", () => {
  expect(safeRedirectPath("/accept-invitation/inv_1")).toBe(
    "/accept-invitation/inv_1",
  );
  expect(safeRedirectPath("/workflows")).toBe("/workflows");
});

test("rejects protocol-relative and absolute URLs", () => {
  expect(safeRedirectPath("//evil.example/phish")).toBeUndefined();
  expect(safeRedirectPath("https://evil.example")).toBeUndefined();
  expect(safeRedirectPath("javascript:alert(1)")).toBeUndefined();
  expect(safeRedirectPath("/\\evil.example/phish")).toBeUndefined();
});

test("rejects non-strings and relative paths", () => {
  expect(safeRedirectPath(undefined)).toBeUndefined();
  expect(safeRedirectPath(42)).toBeUndefined();
  expect(safeRedirectPath("chat")).toBeUndefined();
  expect(safeRedirectPath("")).toBeUndefined();
});
