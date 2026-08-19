/**
 * Unit cover for the per-provider effort mapping. The WIRE behaviour these
 * feed is asserted separately on real request bytes in `reasoning-wire.test.ts`
 * — these tests pin the two rules that are easy to "simplify" into bugs:
 * Anthropic clamps `max`, OpenRouter must not.
 */
import { describe, expect, test } from "bun:test";
import { reasoningEffortSchema, type ReasoningEffort } from "@invisible-string/shared";

import { anthropicReasoningEffort, openRouterReasoningSettings } from "./reasoning";

const ALL_EFFORTS = reasoningEffortSchema.options as readonly ReasoningEffort[];

describe("anthropicReasoningEffort", () => {
  test("clamps `max` to `xhigh` — the SDK union has no `max`", () => {
    // Same clamp the compiler's anthropic branch makes, for the same reason:
    // both values mean "spend the most", and xhigh is the ceiling the union
    // actually offers.
    expect(anthropicReasoningEffort("max")).toBe("xhigh");
    expect(anthropicReasoningEffort("xhigh")).toBe("xhigh");
  });

  test("passes every other effort through unchanged", () => {
    expect(anthropicReasoningEffort("none")).toBe("none");
    expect(anthropicReasoningEffort("minimal")).toBe("minimal");
    expect(anthropicReasoningEffort("low")).toBe("low");
    expect(anthropicReasoningEffort("medium")).toBe("medium");
    expect(anthropicReasoningEffort("high")).toBe("high");
  });

  test("`provider-default` omits the field entirely, unlike `none`", () => {
    // `none` explicitly DISABLES reasoning; `provider-default` sends nothing
    // at all, which is the only verified behaviour for the ~1/3 of catalog
    // models that advertise no reasoning support.
    expect(anthropicReasoningEffort("provider-default")).toBeUndefined();
    expect(anthropicReasoningEffort("none")).toBe("none");
  });
});

describe("openRouterReasoningSettings", () => {
  test("does NOT clamp `max` — OpenRouter accepts it verbatim", () => {
    // The single most important asymmetry with the Anthropic branch above.
    // Clamping here would silently downgrade the seeded `powerful` preset:
    // effort `max` on kimi-k3 returns 5.8x the reasoning tokens of `low`.
    expect(openRouterReasoningSettings("max")).toEqual({
      extraBody: { reasoning: { effort: "max" } },
    });
  });

  test("wraps the effort in the extraBody shape the provider spreads last", () => {
    expect(openRouterReasoningSettings("low")).toEqual({
      extraBody: { reasoning: { effort: "low" } },
    });
    expect(openRouterReasoningSettings("xhigh")).toEqual({
      extraBody: { reasoning: { effort: "xhigh" } },
    });
  });

  test("`provider-default` yields no settings object at all", () => {
    // The caller must then construct a bare `openrouter(id)` — byte-identical
    // to what the compiler emits for the same effort.
    expect(openRouterReasoningSettings("provider-default")).toBeUndefined();
  });

  test("every effort in the shared vocabulary maps to a defined shape", () => {
    // Guards the enum against growing a value this module silently ignores:
    // a new effort added to packages/shared must be handled here too.
    for (const effort of ALL_EFFORTS) {
      const settings = openRouterReasoningSettings(effort);
      if (effort === "provider-default") {
        expect({ effort, settings }).toEqual({ effort, settings: undefined });
        continue;
      }
      expect({ effort, settings }).toEqual({
        effort,
        settings: { extraBody: { reasoning: { effort } } },
      });
    }
  });
});
