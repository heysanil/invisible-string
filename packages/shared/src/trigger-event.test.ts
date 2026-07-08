import { describe, expect, test } from "bun:test";

import {
  base64DecodedByteLength,
  KNOWN_TRIGGER_TYPES,
  TRIGGER_EVENT_INLINE_FILE_MAX_BYTES,
  triggerEventSchema,
  triggerFileSchema,
  type TriggerEvent,
} from "./trigger-event";

const minimalEvent = {
  workflowId: "6b4d8f6e-3a4e-4f6a-9a0e-2f6a1c9d8e7b",
  triggerType: "manual",
  message: "run the weekly report",
  data: {},
  principal: { workspaceId: "org_123", source: "chat" },
} satisfies TriggerEvent;

describe("triggerEventSchema", () => {
  test("parses a minimal envelope", () => {
    const parsed = triggerEventSchema.parse(minimalEvent);
    expect(parsed.workflowId).toBe(minimalEvent.workflowId);
    expect(parsed.files).toBeUndefined();
    expect(parsed.continuationToken).toBeUndefined();
    expect(parsed.context).toBeUndefined();
  });

  test("parses a full envelope (files, principal user, continuation, context)", () => {
    const full = {
      ...minimalEvent,
      triggerType: "slack",
      data: { channel: "C123", text: "hello", thread: { ts: "1.2" } },
      files: [
        { name: "report.pdf", mediaType: "application/pdf", data: "aGVsbG8=" },
        {
          name: "big.bin",
          mediaType: "application/octet-stream",
          data: new URL("https://garage.local/bucket/big.bin"),
        },
      ],
      principal: { workspaceId: "org_123", userId: "user_9", source: "slack:U777" },
      continuationToken: "ct_abc",
      context: ["block one", "block two"],
    } satisfies TriggerEvent;

    const parsed = triggerEventSchema.parse(full);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files?.[1]?.data).toBeInstanceOf(URL);
    expect(parsed.principal.userId).toBe("user_9");
    expect(parsed.context).toEqual(["block one", "block two"]);
  });

  test("triggerType is an open string union (unknown adapters stay valid)", () => {
    expect(
      triggerEventSchema.safeParse({ ...minimalEvent, triggerType: "linear-webhook" })
        .success,
    ).toBe(true);
    // but never empty
    expect(
      triggerEventSchema.safeParse({ ...minimalEvent, triggerType: "" }).success,
    ).toBe(false);
  });

  test("known trigger types include the DB enum values", () => {
    expect(KNOWN_TRIGGER_TYPES).toEqual([
      "manual",
      "form",
      "webhook",
      "slack",
      "schedule",
    ]);
  });

  test("rejects missing principal.workspaceId", () => {
    const result = triggerEventSchema.safeParse({
      ...minimalEvent,
      principal: { source: "chat" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-object data", () => {
    expect(
      triggerEventSchema.safeParse({ ...minimalEvent, data: "not-an-object" }).success,
    ).toBe(false);
    expect(
      triggerEventSchema.safeParse({ ...minimalEvent, data: ["a"] }).success,
    ).toBe(false);
  });

  test("rejects missing message", () => {
    const { message: _message, ...rest } = minimalEvent;
    expect(triggerEventSchema.safeParse(rest).success).toBe(false);
  });

  test("empty message is valid (schedule fires need no user text)", () => {
    expect(
      triggerEventSchema.safeParse({ ...minimalEvent, message: "" }).success,
    ).toBe(true);
  });
});

describe("triggerFileSchema", () => {
  test("rejects empty name / mediaType / data", () => {
    expect(
      triggerFileSchema.safeParse({ name: "", mediaType: "text/plain", data: "aGk=" })
        .success,
    ).toBe(false);
    expect(
      triggerFileSchema.safeParse({ name: "a.txt", mediaType: "", data: "aGk=" })
        .success,
    ).toBe(false);
    expect(
      triggerFileSchema.safeParse({ name: "a.txt", mediaType: "text/plain", data: "" })
        .success,
    ).toBe(false);
  });
});

describe("inline file size cap", () => {
  test("cap is a sane positive number of bytes", () => {
    expect(TRIGGER_EVENT_INLINE_FILE_MAX_BYTES).toBe(1024 * 1024);
  });

  test("base64DecodedByteLength matches real decoded sizes (padding cases)", () => {
    for (const size of [0, 1, 2, 3, 4, 57, 1024, 1024 * 1024]) {
      const bytes = new Uint8Array(size).fill(65);
      const b64 = Buffer.from(bytes).toString("base64");
      expect(base64DecodedByteLength(b64)).toBe(size);
    }
  });

  test("handles unpadded base64", () => {
    const b64 = Buffer.from("hi!").toString("base64"); // "aGkh"
    const unpadded = Buffer.from("hi").toString("base64").replace(/=+$/, ""); // "aGk"
    expect(base64DecodedByteLength(b64)).toBe(3);
    expect(base64DecodedByteLength(unpadded)).toBe(2);
  });

  test("cap enforcement math: a payload one byte over the cap is detectable", () => {
    const over = Buffer.alloc(TRIGGER_EVENT_INLINE_FILE_MAX_BYTES + 1).toString(
      "base64",
    );
    expect(base64DecodedByteLength(over)).toBeGreaterThan(
      TRIGGER_EVENT_INLINE_FILE_MAX_BYTES,
    );
    const at = Buffer.alloc(TRIGGER_EVENT_INLINE_FILE_MAX_BYTES).toString("base64");
    expect(base64DecodedByteLength(at)).toBe(TRIGGER_EVENT_INLINE_FILE_MAX_BYTES);
  });
});
