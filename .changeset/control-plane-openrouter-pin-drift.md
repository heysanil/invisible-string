---
"@invisible-string/control-plane": minor
---

Make reasoning effort actually reach OpenRouter from the control plane: align the AI SDK pins with the compiler's version matrix (retiring a stale `@openrouter/ai-sdk-provider` alpha that silently dropped every reasoning route), route the effort per provider through the new `model/reasoning.ts`, and add `COPILOT_REASONING_EFFORT` (default off) so the copilot can ask for one too.
