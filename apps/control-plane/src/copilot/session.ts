/**
 * Copilot session — one per socket. Holds conversation history across turns
 * and drives the multi-step tool loop for each user message:
 *
 *   user frame → [model round-trip → (validate tool calls → proposal frames →
 *   await accepted/rejected → tool results)]* → done frame
 *
 * Invalid tool calls (schema or semantic) are NEVER forwarded to the client;
 * they return to the model as tool-error results so it self-corrects. Valid
 * calls pause the loop until the client reports the mutation outcome — the
 * outcome IS the tool result, so the model knows what was applied.
 *
 * History invariant: every assistant tool-call message is ALWAYS followed by
 * a tool message pairing each call with a result — aborting mid-proposal
 * synthesizes "aborted" results for the unresolved calls so the next turn's
 * request is never rejected by the provider (Anthropic/OpenAI both 400 on
 * tool_use without a matching tool_result).
 */
import type { ModelMessage } from "ai";
import type {
  CopilotMutationOutcome,
  CopilotServerFrame,
  CopilotSurface,
} from "@invisible-string/shared";

import type { CopilotConfig } from "./config";
import type { WorkspaceInventory } from "./inventory";
import { buildSystemPrompt, buildToolSpecs } from "./prompt";
import type { CopilotTransport } from "./transport";
import {
  applyAcceptedMutation,
  draftStateFor,
  validateMutation,
} from "./validate";

export interface MutationResult {
  outcome: CopilotMutationOutcome;
  reason?: string | undefined;
}

interface PendingProposal {
  resolve: (result: MutationResult) => void;
}

export class CopilotOverBudgetError extends Error {
  override readonly name = "CopilotOverBudgetError";
}

export class CopilotSession {
  private readonly messages: ModelMessage[] = [];
  private readonly pending = new Map<string, PendingProposal>();
  private abortController: AbortController | null = null;
  private turnRunning = false;
  /**
   * Latched when `abort()` arrives while idle — covers the race where the
   * client's Stop lands between the user_message frame and the turn actually
   * starting (the plugin awaits DB checks first). Consumed at the top of the
   * next runTurn; cleared by the plugin when a NEW user_message arrives so a
   * stale post-done abort can never kill a fresh turn.
   */
  private abortRequested = false;

  constructor(
    private readonly deps: {
      transport: CopilotTransport;
      config: CopilotConfig;
      send: (frame: CopilotServerFrame) => void;
      /** Server-side detail sink for upstream failures (default console). */
      logError?: (message: string, error: unknown) => void;
    },
  ) {}

  get busy(): boolean {
    return this.turnRunning;
  }

  /** Client reported the outcome of an applied/dismissed proposal. */
  resolveMutation(proposalId: string, result: MutationResult): void {
    const pending = this.pending.get(proposalId);
    if (!pending) return; // unknown/duplicate — ignore
    this.pending.delete(proposalId);
    pending.resolve(result);
  }

  /** Abort the in-flight turn (latched for the about-to-start turn when idle). */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    } else {
      this.abortRequested = true;
    }
  }

  /** A new user message supersedes any stale idle-abort latch. */
  clearPendingAbort(): void {
    this.abortRequested = false;
  }

  /** Abort + drop all waiters (socket closed). */
  dispose(): void {
    this.abort();
    for (const pending of this.pending.values()) {
      pending.resolve({ outcome: "rejected", reason: "session closed" });
    }
    this.pending.clear();
  }

  /**
   * Run one user turn to completion. Sends delta/proposal frames while
   * streaming and exactly one terminal frame (done or error) at the end.
   * Resolves with the model output tokens the turn consumed (budget metering).
   */
  async runTurn(opts: {
    /** Which editor the turn is about — selects prompt, toolset, validation. */
    surface: CopilotSurface;
    message: string;
    draft: Record<string, unknown>;
    inventory: WorkspaceInventory;
  }): Promise<number> {
    if (this.turnRunning) {
      this.deps.send({
        type: "error",
        code: "turn_in_progress",
        message: "a copilot turn is already streaming on this connection",
      });
      return 0;
    }
    if (this.abortRequested) {
      // Stop clicked between the user_message frame and the turn starting.
      this.abortRequested = false;
      this.deps.send({ type: "done", reason: "aborted", outputTokens: 0 });
      return 0;
    }
    this.turnRunning = true;
    const abortController = new AbortController();
    this.abortController = abortController;

    const system = buildSystemPrompt({
      surface: opts.surface,
      draft: opts.draft,
      inventory: opts.inventory,
    });
    const tools = buildToolSpecs(opts.surface);
    // Draft state the semantic checks run against (carries the surface) —
    // updated as the user accepts proposals so later calls in the same turn
    // see their effect.
    const draftState = draftStateFor(opts.surface, opts.draft);
    this.messages.push({ role: "user", content: opts.message });

    let outputTokens = 0;
    try {
      for (let step = 0; step < this.deps.config.maxStepsPerTurn; step++) {
        abortController.signal.throwIfAborted();

        type ToolCall = { toolCallId: string; toolName: string; input: unknown };
        const toolCalls: ToolCall[] = [];
        let stepText = "";

        for await (const part of this.deps.transport.stream({
          system,
          messages: this.messages,
          tools,
          abortSignal: abortController.signal,
          maxOutputTokens: this.deps.config.maxOutputTokensPerTurn,
        })) {
          if (part.type === "text-delta") {
            stepText += part.text;
            this.deps.send({ type: "delta", text: part.text });
          } else if (part.type === "tool-call") {
            toolCalls.push(part);
          } else if (part.type === "finish") {
            outputTokens += part.outputTokens ?? Math.ceil(stepText.length / 4);
          }
        }

        if (outputTokens > this.deps.config.maxOutputTokensPerTurn) {
          throw new CopilotOverBudgetError(
            `turn exceeded the output budget (${outputTokens} > ${this.deps.config.maxOutputTokensPerTurn} tokens)`,
          );
        }

        if (toolCalls.length === 0) {
          if (stepText) {
            this.messages.push({ role: "assistant", content: stepText });
          }
          this.deps.send({ type: "done", reason: "completed", outputTokens });
          return outputTokens;
        }

        // Record the assistant step (text + tool calls) verbatim.
        this.messages.push({
          role: "assistant",
          content: [
            ...(stepText ? [{ type: "text" as const, text: stepText }] : []),
            ...toolCalls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            })),
          ],
        });

        // Resolve each call: invalid → tool error back to the model; valid →
        // proposal to the client, pause until accepted/rejected. The results
        // message is pushed in `finally` so an abort mid-proposal still pairs
        // every tool call with a (synthesized) result — see header invariant.
        const toolResults: ModelMessage = { role: "tool", content: [] };
        const resultFor = (call: ToolCall, text: string) => ({
          type: "tool-result" as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text" as const, value: text },
        });
        const resolved = new Set<string>();
        try {
          for (const call of toolCalls) {
            abortController.signal.throwIfAborted();
            const validation = validateMutation(
              call.toolName,
              call.input,
              opts.inventory,
              draftState,
            );
            let resultText: string;
            if (!validation.ok) {
              resultText = `INVALID TOOL CALL (not shown to the user): ${validation.message}. Fix the call and try again.`;
            } else {
              const rationale = extractRationale(call.input);
              this.deps.send({
                type: "proposal",
                proposal: {
                  id: call.toolCallId,
                  tool: validation.tool,
                  params: validation.params,
                  rationale,
                } as never,
              });
              const result = await this.waitForOutcome(
                call.toolCallId,
                abortController.signal,
              );
              if (result.outcome === "accepted") {
                applyAcceptedMutation(
                  draftState,
                  validation.tool,
                  validation.params,
                );
                resultText = "accepted — the user applied this change to the draft";
              } else {
                resultText = `rejected — the user dismissed this proposal${result.reason ? `: ${result.reason}` : ""}`;
              }
            }
            (toolResults.content as unknown[]).push(resultFor(call, resultText));
            resolved.add(call.toolCallId);
          }
        } finally {
          for (const call of toolCalls) {
            if (!resolved.has(call.toolCallId)) {
              (toolResults.content as unknown[]).push(
                resultFor(call, "aborted by the user before a decision"),
              );
            }
          }
          this.messages.push(toolResults);
        }
      }
      // Step cap reached without a natural stop.
      throw new CopilotOverBudgetError(
        `turn exceeded ${this.deps.config.maxStepsPerTurn} model round-trips`,
      );
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        this.deps.send({ type: "done", reason: "aborted", outputTokens });
      } else if (error instanceof CopilotOverBudgetError) {
        this.deps.send({ type: "error", code: "over_budget", message: error.message });
      } else {
        // Upstream errors can carry provider URLs/headers/response bodies —
        // log the detail server-side, send only a generic line to the client.
        (this.deps.logError ?? defaultLogError)("copilot llm turn failed", error);
        this.deps.send({
          type: "error",
          code: "llm_error",
          message: "the copilot model call failed — try again",
        });
      }
    } finally {
      // Drop stale waiters so a next turn never resolves against old ids.
      for (const pending of this.pending.values()) {
        pending.resolve({ outcome: "rejected", reason: "turn ended" });
      }
      this.pending.clear();
      this.abortController = null;
      this.turnRunning = false;
    }
    return outputTokens;
  }

  private waitForOutcome(
    proposalId: string,
    signal: AbortSignal,
  ): Promise<MutationResult> {
    return new Promise<MutationResult>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(proposalId);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(proposalId, {
        resolve: (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
      });
    });
  }
}

function defaultLogError(message: string, error: unknown): void {
  console.error(`[copilot] ${message}:`, error);
}

/** Models often include a `rationale` in the tool input; surface it if so. */
function extractRationale(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const value = (input as Record<string, unknown>).rationale;
    if (typeof value === "string") return value;
  }
  return "";
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
