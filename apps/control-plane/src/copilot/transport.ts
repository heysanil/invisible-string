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
 * - `createKeyedScriptedTransport` — STATELESS fake for the browser E2E
 *   harness: scripts are keyed by a substring of the user message and the
 *   step index is derived from the conversation itself (tool-result messages
 *   since the last user turn), so any number of sockets/turns/spec retries
 *   replay deterministically from one env var. Supports placeholders that a
 *   real model would resolve by reading the system prompt's inventory:
 *   `{{connectionId:<slug>}}`, `{{skillId:<slug>}}`, `{{agentId:<name>}}` in
 *   tool inputs, and `{{toolResults}}` in step text (echoes the outcomes the
 *   model was told).
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

// ── keyed scripted fake transport (E2E harness) ──────────────────────────────

/**
 * One keyed conversation script: selected when `match` is a substring of the
 * latest user message; `steps` are indexed by how many model round-trips this
 * turn has already completed (derived from the message history, not from
 * transport state).
 */
export interface KeyedScript {
  match: string;
  steps: ScriptedStep[];
}

/** Plain-text view of a ModelMessage's content (string or text parts). */
function messageText(message: ModelMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return "";
}

/** "toolName: result text" summary of the LAST tool-results message. */
function lastToolResultsSummary(messages: ModelMessage[]): string {
  const toolMessage = [...messages].reverse().find((m) => m.role === "tool");
  if (!toolMessage || !Array.isArray(toolMessage.content)) return "(none)";
  return toolMessage.content
    .map((part) => {
      const output = (part as { output?: { value?: unknown } }).output;
      const value = typeof output?.value === "string" ? output.value : "";
      return `${(part as { toolName?: string }).toolName ?? "?"}: ${value}`;
    })
    .join("; ");
}

/**
 * Resolve `{{connectionId:<slug>}}` / `{{skillId:<slug>}}` /
 * `{{agentId:<name>}}` placeholders in a tool input against the inventory
 * lines of the system prompt (exactly the data a real model reads:
 * `- id=<uuid> name="…" ref=@<slug>` / `ref=@skill.<slug>` for context, and
 * `- id=<uuid> name="<name>" …` for the workflow surface's agent inventory,
 * which carries no ref slug — agents are matched by exact name).
 * Unresolvable placeholders are left as-is so schema validation rejects them
 * loudly (a script bug, never a silent pass).
 */
function substituteInventoryIds(input: unknown, system: string): unknown {
  const raw = JSON.stringify(input);
  if (!raw.includes("{{")) return input;
  const substituted = raw
    .replace(
      /\{\{(connectionId|skillId):([A-Za-z0-9_-]+)\}\}/g,
      (whole, kind: string, slug: string) => {
        const ref = kind === "connectionId" ? `@${slug}` : `@skill.${slug}`;
        const line = new RegExp(
          `- id=(\\S+) name="[^"]*" ref=${ref.replace(/[.$]/g, "\\$&")}(?![A-Za-z0-9_.-])`,
        ).exec(system);
        return line?.[1] ?? whole;
      },
    )
    .replace(/\{\{agentId:([^{}"]+)\}\}/g, (whole, name: string) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const line = new RegExp(`- id=(\\S+) name="${escaped}"`).exec(system);
      return line?.[1] ?? whole;
    });
  return JSON.parse(substituted);
}

/**
 * Deterministic, stateless fake LLM keyed on the user message. Each
 * `stream()` call independently derives (script, step) from the request:
 * - script: first {@link KeyedScript} whose `match` occurs in the latest
 *   user message;
 * - step: the number of tool-result messages SINCE that user message (== the
 *   round-trips already completed this turn).
 * Running past the script's end (or matching no script) yields an empty
 * finish, ending the turn naturally.
 */
export function createKeyedScriptedTransport(
  scripts: KeyedScript[],
): CopilotTransport {
  return {
    async *stream(request) {
      request.abortSignal.throwIfAborted();
      const lastUserIndex = request.messages.findLastIndex(
        (m) => m.role === "user",
      );
      const userText = messageText(request.messages[lastUserIndex]);
      const script = scripts.find((s) => userText.includes(s.match));
      const stepIndex = request.messages
        .slice(lastUserIndex + 1)
        .filter((m) => m.role === "tool").length;
      const step = script?.steps[stepIndex];
      if (!step) {
        yield { type: "finish", outputTokens: 0 };
        return;
      }
      if (step.text) {
        const text = step.text.replace(
          "{{toolResults}}",
          lastToolResultsSummary(request.messages),
        );
        // Emit in two chunks so delta streaming is observable end-to-end.
        const mid = Math.ceil(text.length / 2);
        yield { type: "text-delta", text: text.slice(0, mid) };
        request.abortSignal.throwIfAborted();
        yield { type: "text-delta", text: text.slice(mid) };
      }
      for (const [index, call] of (step.toolCalls ?? []).entries()) {
        request.abortSignal.throwIfAborted();
        yield {
          type: "tool-call",
          // Salted with the conversation length so replaying the SAME user
          // message on one socket never reuses a proposal id (the client
          // keys suggestion cards by id and resolves the first match).
          toolCallId: `fake_${script!.match.replace(/\W+/g, "_")}_${request.messages.length}_${stepIndex}_${index}`,
          toolName: call.toolName,
          input: substituteInventoryIds(call.input, request.system),
        };
      }
      yield {
        type: "finish",
        outputTokens: step.outputTokens ?? Math.ceil((step.text?.length ?? 0) / 4),
      };
    },
  };
}

/**
 * Build the fake transport COPILOT_FAKE_SCRIPT describes. Two formats:
 * - `[{text?, toolCalls?}, …]` — sequential steps (unit/integration tests);
 * - `[{match, steps: […]}, …]` — keyed scripts (browser E2E harness).
 */
export function createFakeTransport(json: string): CopilotTransport {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("COPILOT_FAKE_SCRIPT must be a JSON array");
  }
  const keyed = parsed.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { match?: unknown }).match === "string" &&
      Array.isArray((entry as { steps?: unknown }).steps),
  );
  return keyed && parsed.length > 0
    ? createKeyedScriptedTransport(parsed as KeyedScript[])
    : createScriptedTransport(parsed as ScriptedStep[]);
}
