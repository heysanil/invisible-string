/**
 * Reasoning effort → provider call shape, for the control plane's own DIRECT
 * SDK callers (the session titler and the copilot).
 *
 * This is the runtime twin of what `packages/compiler/src/codegen/agent.ts`
 * EMITS for a compiled agent, and it exists for the same reason the codegen
 * does: the two providers take the effort by completely different routes, and
 * exactly one of them is the route the AI SDK documents.
 *
 * ANTHROPIC (`@ai-sdk/anthropic`) is spec-v4 and its `getArgs()` DOES
 * destructure ai@7's top-level `reasoning` call option, mapping it onto a
 * thinking budget. That is the blessed route and it lands. Its union tops out
 * at `xhigh`, so the platform's `max` clamps there — the same clamp the
 * compiler's anthropic branch makes, for the same reason: both mean "spend the
 * most".
 *
 * OPENROUTER (`@openrouter/ai-sdk-provider`) does NOT. Verified against the
 * pinned 3.0.0 dist: `OpenRouterChatLanguageModel.getArgs()` destructures
 * `prompt, maxOutputTokens, temperature, topP, frequencyPenalty,
 * presencePenalty, seed, stopSequences, responseFormat, topK, tools,
 * toolChoice` — and nothing else. `reasoning` is silently dropped (spike
 * finding 29). The effort therefore rides the MODEL's `extraBody`, which the
 * same class spreads LAST over the assembled body (`dist/index.js:3648`, after
 * `config.extraBody`) and which therefore wins over everything.
 *
 * Two rules follow, and both are easy to "simplify" into bugs:
 *
 *  - Do NOT use the provider's TYPED `reasoning` setting instead. Its effort
 *    union is `'xhigh'|'high'|'medium'|'low'|'minimal'|'none'` — it has no
 *    `max`, which is the very setting the seeded `powerful` preset uses.
 *  - Do NOT clamp `max` on the OpenRouter branch. OpenRouter's API accepts it
 *    and answers it with materially more reasoning (5.8x the tokens of `low`
 *    on kimi-k3), so clamping would silently downgrade the top setting. Only
 *    Anthropic clamps, because only its SDK union forces it.
 *
 * Both branches are asserted on real request bytes in `reasoning-wire.test.ts`
 * — the OpenRouter one through both of its callers, the Anthropic one through
 * this module's helper (neither caller accepts an Anthropic base URL) — as is
 * the negative that justifies the `extraBody` detour. So if a future provider
 * release starts honouring the call option, that suite fails and this module
 * can collapse into one branch.
 *
 * HISTORICAL: until the pin move that added this file, `apps/control-plane`
 * sat on `@openrouter/ai-sdk-provider@6.0.0-alpha.1` — a STALE PARALLEL ALPHA
 * (published 2026-01-07, six months BEFORE 3.0.0's 2026-07-06 `latest`) whose
 * chat model built a whitelisted Responses-API body and stored `extraBody`
 * without ever reading it. On that line neither route reached the wire, so the
 * titler's effort was inert. See `packages/compiler/versions.json` note 5.
 */
import type { ReasoningEffort } from "@invisible-string/shared";

/**
 * The efforts `@ai-sdk/anthropic` maps onward when handed ai@7's top-level
 * `reasoning` call option. A SUBSET of the spec union, chosen from the
 * provider's own effort map (`minimal|low -> low`, `medium`, `high`,
 * `xhigh`, plus `none`): note the absent `max`, which is why this branch — and
 * only this branch — clamps.
 *
 * On the wire (proven in `reasoning-wire.test.ts`) these become
 * `thinking: {type: "adaptive", display: "summarized"}` plus
 * `output_config.effort`, except `none`, which becomes
 * `thinking: {type: "disabled"}`.
 */
export type AnthropicReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

/**
 * Anthropic branch: the value for ai@7's top-level `reasoning` call option.
 *
 * `provider-default` returns undefined so the field is omitted ENTIRELY, which
 * is deliberately distinct from an explicit `"none"` (reasoning off): roughly
 * a third of catalog models advertise no reasoning support at all, and for
 * those an omitted block is the only verified behaviour.
 */
export function anthropicReasoningEffort(
  effort: ReasoningEffort,
): AnthropicReasoningEffort | undefined {
  if (effort === "provider-default") return undefined;
  return effort === "max" ? "xhigh" : effort;
}

/** Model settings for `openrouter(modelId, …)` carrying a reasoning effort. */
export interface OpenRouterReasoningSettings {
  extraBody: { reasoning: { effort: Exclude<ReasoningEffort, "provider-default"> } };
}

/**
 * OpenRouter branch: the SETTINGS OBJECT for `openrouter(modelId, settings)`.
 *
 * Returns undefined for `provider-default` so the caller constructs a bare
 * `openrouter(modelId)` with no settings at all — byte-for-byte the shape the
 * compiler emits for the same effort. The effort is passed VERBATIM (including
 * `max`); see the module header for why this branch must not clamp.
 */
export function openRouterReasoningSettings(
  effort: ReasoningEffort,
): OpenRouterReasoningSettings | undefined {
  if (effort === "provider-default") return undefined;
  return { extraBody: { reasoning: { effort } } };
}
