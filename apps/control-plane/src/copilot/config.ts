/**
 * Copilot configuration (spec §12). The copilot calls a Claude model through
 * OpenRouter on the platform key by default (no ANTHROPIC_API_KEY exists in
 * this deployment); the direct-Anthropic path is implemented but inactive
 * until a key is provided.
 */

export type CopilotProvider = "openrouter" | "anthropic";

/**
 * Default model slug — best current Claude on OpenRouter, verified against
 * the live model list (https://openrouter.ai/api/v1/models) on 2026-07-03.
 */
export const DEFAULT_COPILOT_MODEL = "anthropic/claude-sonnet-5";

export interface CopilotConfig {
  provider: CopilotProvider;
  /** Provider model slug (OpenRouter: "anthropic/..."; Anthropic: "claude-..."). */
  model: string;
  /** OPENROUTER_BASE_URL override (tests point this at a stub). */
  openRouterBaseUrl: string | undefined;
  /** Per-workspace concurrent copilot session cap (COPILOT_MAX_SESSIONS, default 2). */
  maxSessionsPerWorkspace: number;
  /** Per-turn model OUTPUT token budget (COPILOT_MAX_OUTPUT_TOKENS, default 8192). */
  maxOutputTokensPerTurn: number;
  /** Per-turn model round-trip cap — bounds runaway tool loops (default 12). */
  maxStepsPerTurn: number;
  /**
   * Rolling per-workspace spend window (COPILOT_BUDGET_WINDOW_MS, default 1h).
   * The per-turn caps above bound a single turn; these bound the AGGREGATE a
   * workspace can bill to the platform key inside the window — without them a
   * member could loop cheap turns forever (budget-cap bypass via many turns).
   */
  budgetWindowMs: number;
  /** Max copilot turns per workspace per window (COPILOT_MAX_TURNS_PER_WINDOW, default 60). */
  maxTurnsPerWindow: number;
  /**
   * Max estimated tokens (input estimate + reported output) per workspace per
   * window (COPILOT_MAX_TOKENS_PER_WINDOW, default 400k).
   */
  maxTokensPerWindow: number;
  /**
   * Scripted fake-LLM steps (COPILOT_FAKE_SCRIPT, JSON) — dev/test only.
   * NEVER honored when NODE_ENV=production (loadCopilotConfig drops it), so a
   * stray fake-script env var can never downgrade a production copilot; the
   * real provider key wins there.
   */
  fakeScript: string | undefined;
}

function positiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function loadCopilotConfig(
  env: Record<string, string | undefined> = process.env,
): CopilotConfig {
  const provider =
    env.COPILOT_PROVIDER?.trim() === "anthropic" ? "anthropic" : "openrouter";
  return {
    provider,
    model:
      env.COPILOT_MODEL?.trim() ||
      (provider === "anthropic" ? "claude-sonnet-4-5" : DEFAULT_COPILOT_MODEL),
    openRouterBaseUrl: env.OPENROUTER_BASE_URL?.trim() || undefined,
    maxSessionsPerWorkspace: positiveInt(env.COPILOT_MAX_SESSIONS, 2),
    maxOutputTokensPerTurn: positiveInt(env.COPILOT_MAX_OUTPUT_TOKENS, 8_192),
    maxStepsPerTurn: positiveInt(env.COPILOT_MAX_STEPS, 12),
    budgetWindowMs: positiveInt(env.COPILOT_BUDGET_WINDOW_MS, 3_600_000),
    maxTurnsPerWindow: positiveInt(env.COPILOT_MAX_TURNS_PER_WINDOW, 60),
    maxTokensPerWindow: positiveInt(env.COPILOT_MAX_TOKENS_PER_WINDOW, 400_000),
    // Fake mode is dev/test-gated: it cannot be enabled against prod config.
    fakeScript:
      env.NODE_ENV === "production"
        ? undefined
        : env.COPILOT_FAKE_SCRIPT?.trim() || undefined,
  };
}
