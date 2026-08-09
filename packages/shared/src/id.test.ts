import { describe, expect, test } from "bun:test";
import { newId } from "./id";

describe("newId", () => {
  test("shape: prefix underscore + 16 lowercase alphanumerics", () => {
    const id = newId("cn");
    expect(id).toMatch(/^cn_[0-9a-z]{16}$/);
  });

  test("ids are unique across a large batch", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId("cn")));
    expect(ids.size).toBe(10_000);
  });

  test("prefix is used verbatim", () => {
    expect(newId("co").startsWith("co_")).toBe(true);
  });
});
