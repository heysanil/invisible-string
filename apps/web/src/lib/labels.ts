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

export const REASONING_LABEL: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

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
