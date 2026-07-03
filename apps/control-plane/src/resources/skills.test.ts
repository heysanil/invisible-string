import { describe, expect, test } from "bun:test";

import { RuntimeApiError } from "../runtime/errors";
import {
  assertSafeAttachmentName,
  assertTextAttachment,
  skillFileKey,
} from "./skills";

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

describe("assertTextAttachment", () => {
  const enc = new TextEncoder();

  test("accepts UTF-8 text (markdown, unicode)", () => {
    expect(() =>
      assertTextAttachment(enc.encode("# On-call\n- Renée ✓\n"), "rota.md"),
    ).not.toThrow();
    expect(() => assertTextAttachment(new Uint8Array(0), "empty.txt")).not.toThrow();
  });

  test("rejects NUL bytes (binary containers: zip/pdf/image)", () => {
    const withNul = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]);
    expect(() => assertTextAttachment(withNul, "doc.pdf")).toThrow(RuntimeApiError);
  });

  test("rejects invalid UTF-8 (e.g. lone continuation byte)", () => {
    const invalid = new Uint8Array([0xff, 0xfe, 0x80]);
    expect(() => assertTextAttachment(invalid, "image.png")).toThrow(RuntimeApiError);
  });
});

describe("skillFileKey", () => {
  test("namespaces the object under the skill id", () => {
    expect(skillFileKey("skill-1", "references/rota.md")).toBe(
      "skills/skill-1/references/rota.md",
    );
  });
});
