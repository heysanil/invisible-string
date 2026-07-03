import { describe, expect, test } from "bun:test";

import { RuntimeApiError } from "../runtime/errors";
import { assertSafeAttachmentName, skillFileKey } from "./skills";

describe("assertSafeAttachmentName", () => {
  test("accepts plain names and safe subpaths", () => {
    expect(() => assertSafeAttachmentName("rota.md")).not.toThrow();
    expect(() => assertSafeAttachmentName("references/rota.md")).not.toThrow();
    expect(() => assertSafeAttachmentName("a/b/c.txt")).not.toThrow();
  });

  test("rejects traversal, absolute paths, nulls, and empties", () => {
    for (const bad of ["", "/etc/passwd", "../secret", "a/../../b", "x\0y"]) {
      expect(() => assertSafeAttachmentName(bad)).toThrow(RuntimeApiError);
    }
  });
});

describe("skillFileKey", () => {
  test("namespaces the object under the skill id", () => {
    expect(skillFileKey("skill-1", "references/rota.md")).toBe(
      "skills/skill-1/references/rota.md",
    );
  });
});
