/**
 * Copilot LLM transport — one model round-trip per `stream()` call. Two
 * implementations:
 *
 * - `createModelTransport` — the real thing via ai@7 `streamText` against
 *   OpenRouter (default; platform key) or Anthropic (implemented, inactive
 *   without ANTHROPIC_API_KEY). Tool input schemas are passed as raw JSON
 *   schema with a pass-through validator: the session loop owns validation
 *   (zod + semantic) so invalid calls become model-facing tool errors instead
 *   of transport crashes.
 * - `createScriptedTransport` — deterministic fake for unit/integration
 *   tests (COPILOT_FAKE_SCRIPT): a sequence of {text?, toolCalls?} steps,
 *   one consumed per round-trip.
 */
import { jsonSchema, streamText, tool, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import type { CopilotConfig } from "./config";

export interface TransportToolSpec {
  name: string;
  description: string;
  /** JSON schema for the tool input (already converted from zod). */
  inputSchema: Record<string, unknown>;
}

export type TransportPart =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "finish"; outputTokens: number | undefined };

export interface TransportRequest {
  system: string;
  messages: ModelMessage[];
  tools: TransportToolSpec[];
  abortSignal: AbortSignal;
  maxOutputTokens: number;
}

export interface CopilotTransport {
  stream(request: TransportRequest): AsyncIterable<TransportPart>;
}

// ── real transport (ai@7) ────────────────────────────────────────────────────

export function createModelTransport(
  config: CopilotConfig,
  env: Record<string, string | undefined> = process.env,
): CopilotTransport {
  // Construct the provider model lazily so a keyless boot never throws
  // (openrouter('slug') raises AI_LoadAPIKeyError at construction time).
  const makeModel = () => {
    if (config.provider === "anthropic") {
      const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
      return anthropic(config.model);
    }
    const openrouter = createOpenRouter({
      apiKey: env.OPENROUTER_API_KEY,
      ...(config.openRouterBaseUrl ? { baseURL: config.openRouterBaseUrl } : {}),
    });
    return openrouter(config.model);
  };

  return {
    async *stream(request) {
      const tools = Object.fromEntries(
        request.tools.map((spec) => [
          spec.name,
          tool({
            description: spec.description,
            // Pass-through validator: the session loop validates inputs and
            // routes failures back to the model as tool errors.
            inputSchema: jsonSchema<unknown>(spec.inputSchema as never, {
              validate: (value) => ({ success: true, value }),
            }),
          }),
        ]),
      );
      const result = streamText({
        model: makeModel(),
        system: request.system,
        messages: request.messages,
        tools,
        toolChoice: "auto",
        abortSignal: request.abortSignal,
        maxOutputTokens: request.maxOutputTokens,
      });
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text-delta", text: part.text };
            break;
          case "tool-call":
            yield {
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            };
            break;
          case "error":
            throw part.error instanceof Error
              ? part.error
              : new Error(String(part.error));
          case "finish":
            yield {
              type: "finish",
              outputTokens: part.totalUsage?.outputTokens,
            };
            break;
          default:
            break;
        }
      }
    },
  };
}

// ── scripted fake transport ──────────────────────────────────────────────────

/** One scripted model round-trip: optional text, then optional tool calls. */
export interface ScriptedStep {
  text?: string;
  toolCalls?: Array<{ toolName: string; input: unknown }>;
  /** Reported output-token usage for this step (default: text length / 4). */
  outputTokens?: number;
}

/**
 * Deterministic fake LLM. Each `stream()` call consumes the next step; when
 * the script is exhausted the model "stops" (text-only empty turn), ending
 * the loop. Captures every request for assertions.
 */
export function createScriptedTransport(script: ScriptedStep[]): CopilotTransport & {
  requests: TransportRequest[];
} {
  let cursor = 0;
  const requests: TransportRequest[] = [];
  return {
    requests,
    // eslint-disable-next-line require-yield
    async *stream(request) {
      requests.push(request);
      request.abortSignal.throwIfAborted();
      const step = script[cursor++];
      if (!step) {
        yield { type: "finish", outputTokens: 0 };
        return;
      }
      if (step.text) {
        // Emit in two chunks so delta streaming is observable.
        const mid = Math.ceil(step.text.length / 2);
        yield { type: "text-delta", text: step.text.slice(0, mid) };
        request.abortSignal.throwIfAborted();
        yield { type: "text-delta", text: step.text.slice(mid) };
      }
      for (const [index, call] of (step.toolCalls ?? []).entries()) {
        request.abortSignal.throwIfAborted();
        yield {
          type: "tool-call",
          toolCallId: `fake_${cursor}_${index}`,
          toolName: call.toolName,
          input: call.input,
        };
      }
      yield {
        type: "finish",
        outputTokens:
          step.outputTokens ?? Math.ceil((step.text?.length ?? 0) / 4),
      };
    },
  };
}

/** Parse COPILOT_FAKE_SCRIPT (JSON array of {@link ScriptedStep}). */
export function parseFakeScript(json: string): ScriptedStep[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("COPILOT_FAKE_SCRIPT must be a JSON array of steps");
  }
  return parsed as ScriptedStep[];
}
