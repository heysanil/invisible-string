import { describe, expect, test } from "bun:test";

import {
  PIPELINE_STEP_OUTPUT_PREVIEW_MAX_BYTES,
  PIPELINE_STREAM_EVENT_TYPES,
  buildStepOutputPreview,
  isPipelineStreamEvent,
  type PipelineStreamEvent,
} from "./pipeline-events";

describe("isPipelineStreamEvent", () => {
  test("narrows pipeline.* events; eve and unknown types fall through", () => {
    const started: PipelineStreamEvent = {
      type: "pipeline.step.started",
      data: {
        stepId: "st_0000000000000001",
        slug: "search",
        kind: "tool",
        path: "st_0000000000000001",
        attempt: 1,
      },
    };
    expect(isPipelineStreamEvent(started)).toBe(true);
    expect(isPipelineStreamEvent({ type: "step.started" })).toBe(false); // eve's
    expect(isPipelineStreamEvent({ type: "pipeline.future.thing" })).toBe(false);
    expect(PIPELINE_STREAM_EVENT_TYPES).toHaveLength(7);
  });
});

describe("buildStepOutputPreview", () => {
  test("small outputs pass through as exact JSON", () => {
    expect(buildStepOutputPreview({ ok: true, n: 3 })).toBe('{"ok":true,"n":3}');
    expect(buildStepOutputPreview("text")).toBe('"text"');
  });

  test("values with no JSON projection yield undefined", () => {
    expect(buildStepOutputPreview(undefined)).toBeUndefined();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(buildStepOutputPreview(circular)).toBeUndefined();
  });

  test("truncates to the byte cap on a UTF-8 boundary", () => {
    const preview = buildStepOutputPreview({ text: "é".repeat(4096) });
    expect(preview).toBeDefined();
    const bytes = new TextEncoder().encode(preview);
    expect(bytes.length).toBeLessThanOrEqual(
      PIPELINE_STEP_OUTPUT_PREVIEW_MAX_BYTES,
    );
    // No replacement char from a split code point.
    expect(preview?.endsWith("�")).toBe(false);
    expect(preview?.startsWith('{"text":"é')).toBe(true);
  });
});
