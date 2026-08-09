/** Human-facing labels for the enum-ish values the settings/context UI shows. */
import type {
  McpApprovalDecision,
  ModelProvider,
  ReasoningEffort,
} from "@invisible-string/shared";
import type { ModelPresetSlug } from "@invisible-string/shared";

export const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

export const PRESET_LABEL: Record<ModelPresetSlug, string> = {
  powerful: "Powerful",
  balanced: "Balanced",
  quick: "Quick",
};

export const PRESET_HINT: Record<ModelPresetSlug, string> = {
  powerful: "Deepest reasoning for hard, open-ended work.",
  balanced: "The everyday default — capable and fast.",
  quick: "Snappy and cheap for simple, high-volume steps.",
};

export const PRESET_ORDER: ModelPresetSlug[] = ["powerful", "balanced", "quick"];

/**
 * The full effort vocabulary. `provider-default` is the platform's own value
 * — "send no reasoning field at all" — and reads as "Model default" rather
 * than naming a level, because that is what the user is choosing.
 */
export const REASONING_LABEL: Record<ReasoningEffort, string> = {
  "provider-default": "Model default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * Canonical weakest→strongest display order (the schema's own order), and the
 * fallback option list whenever a model's supported set is unknown.
 */
export const REASONING_ORDER: ReasoningEffort[] = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Order a model's catalog `supportedEfforts` for display. MANDATORY, not
 * cosmetic: OpenRouter returns the set DESCENDING (`["max","high","low"]`),
 * so a selector fed straight from the catalog would render backwards relative
 * to the {@link REASONING_ORDER} fallback list. Unknown values (a catalog
 * that grew a level we don't model) sort last rather than being dropped.
 */
export function sortReasoningEfforts(
  efforts: readonly ReasoningEffort[],
): ReasoningEffort[] {
  const rank = (effort: ReasoningEffort) => {
    const index = REASONING_ORDER.indexOf(effort);
    return index === -1 ? REASONING_ORDER.length : index;
  };
  return [...efforts].sort((a, b) => rank(a) - rank(b));
}

/**
 * The option list an effort selector should offer for one model.
 * `provider-default` is ALWAYS included and always first: it means "send no
 * reasoning field at all", which is legal on every model (the copilot
 * validator exempts it for the same reason) and is the ONLY safe choice on a
 * model the catalog lists with an EMPTY supported set — listed, but no
 * reasoning support. Offering only `supportedEfforts` there would render a
 * selector with nothing usable in it. The catalog parser strips
 * `provider-default` from supported sets (it is the platform's own value, not
 * a provider capability), so nothing is ever offered twice.
 *
 * `null` = the supported set is UNKNOWN (no catalog row, unreachable catalog,
 * or a non-OpenRouter provider) → offer the whole vocabulary.
 */
export function offeredReasoningEfforts(
  supported: readonly ReasoningEffort[] | null,
): ReasoningEffort[] {
  if (supported === null) return [...REASONING_ORDER];
  return [
    "provider-default",
    ...sortReasoningEfforts(
      supported.filter((effort) => effort !== "provider-default"),
    ),
  ];
}

export const APPROVAL_LABEL: Record<McpApprovalDecision, string> = {
  never: "Auto-allow",
  once: "Ask once",
  always: "Always ask",
};

export const APPROVAL_HINT: Record<McpApprovalDecision, string> = {
  never: "Tools run without asking.",
  once: "Ask the first time each session, then remember.",
  always: "Ask every time a tool runs.",
};
