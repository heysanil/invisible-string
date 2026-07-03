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
 */
import type { ModelMessage } from "ai";
import type {
  CopilotMutationOutcome,
  CopilotServerFrame,
} from "@invisible-string/shared";

import type { CopilotConfig } from "./config";
import type { WorkspaceInventory } from "./inventory";
import { buildSystemPrompt, buildToolSpecs } from "./prompt";
import type { CopilotTransport } from "./transport";
import { validateMutation } from "./validate";

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

  constructor(
    private readonly deps: {
      transport: CopilotTransport;
      config: CopilotConfig;
      send: (frame: CopilotServerFrame) => void;
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

  /** Abort the in-flight turn (no-op when idle). */
  abort(): void {
    this.abortController?.abort();
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
   */
  async runTurn(opts: {
    message: string;
    draft: Record<string, unknown>;
    inventory: WorkspaceInventory;
  }): Promise<void> {
    if (this.turnRunning) {
      this.deps.send({
        type: "error",
        code: "turn_in_progress",
        message: "a copilot turn is already streaming on this connection",
      });
      return;
    }
    this.turnRunning = true;
    const abortController = new AbortController();
    this.abortController = abortController;

    const system = buildSystemPrompt({
      draft: opts.draft,
      inventory: opts.inventory,
    });
    const tools = buildToolSpecs();
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
          return;
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
        // proposal to the client, pause until accepted/rejected.
        const toolResults: ModelMessage = { role: "tool", content: [] };
        for (const call of toolCalls) {
          abortController.signal.throwIfAborted();
          const validation = validateMutation(
            call.toolName,
            call.input,
            opts.inventory,
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
            resultText =
              result.outcome === "accepted"
                ? "accepted — the user applied this change to the draft"
                : `rejected — the user dismissed this proposal${result.reason ? `: ${result.reason}` : ""}`;
          }
          (toolResults.content as unknown[]).push({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "text", value: resultText },
          });
        }
        this.messages.push(toolResults);
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
        this.deps.send({
          type: "error",
          code: "llm_error",
          message: error instanceof Error ? error.message : String(error),
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
