/**
 * Copilot session — one per socket. Holds conversation history across turns
 * and drives the multi-step tool loop for each user message:
 *
 *   user frame → [model round-trip → (validate tool calls → proposal frames →
 *   await accepted/rejected → tool results)]* → done frame
 *
 * Invalid tool calls (schema or semantic) are NEVER forwarded to the client as
 * PROPOSALS; they return to the model as tool-error results so it
 * self-corrects. Valid calls pause the loop until the client reports the
 * mutation outcome — the outcome IS the tool result, so the model knows what
 * was applied — unless ALLOW-EDITS is on for the turn (spec D7.2), in which
 * case the proposal is streamed with `autoApplied: true` and the loop
 * continues immediately: the client still applies (single writer, unchanged)
 * and still renders the card, so the turn stays an audit trail.
 *
 * What the client SEES of all this (spec D7.1) is three frame kinds beyond
 * `delta`: a `thought` per round-trip that carries the model's reasoning
 * cumulatively, a `step` per tool call carrying only lifecycle
 * (pending → ok/error) so the dock can render the chat's rail-in-box grammar,
 * and the existing `proposal`. Step frames are emitted for INVALID calls too —
 * that is not a leak of the self-correction protocol, because the preview is
 * the (workspace-derived, user-safe) validation problem, never the model-facing
 * "INVALID TOOL CALL …" scaffolding, and never a card the user could accept.
 *
 * History invariant: every assistant tool-call message is ALWAYS followed by
 * a tool message pairing each call with a result — aborting mid-proposal
 * synthesizes "aborted" results for the unresolved calls so the next turn's
 * request is never rejected by the provider (Anthropic/OpenAI both 400 on
 * tool_use without a matching tool_result).
 */
import type { ModelMessage } from "ai";
import {
  summarizeToolResult,
  type CopilotAgentIdentity,
  type CopilotMutationOutcome,
  type CopilotServerFrame,
  type CopilotStepState,
  type CopilotSurface,
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
  /**
   * Monotonic turn counter, used ONLY to key thought blocks. The dock upserts
   * timeline items by key globally, so `step:<index>` alone collides across
   * turns on one socket (every turn's step loop restarts at zero) and turn 2's
   * reasoning would replace turn 1's inside its old work block. Never reset.
   */
  private turnIndex = 0;

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
    /**
     * The agent's row identity (spec D7.3/D7.4) — the editor's live values,
     * else the persisted row the plugin resolved for it. Null on the workflow
     * surface and when nothing could be resolved; the prompt then states no
     * identity and the no-op checks simply do not fire, which is the right
     * failure direction (a missing baseline must never turn a legitimate
     * rename into an error).
     */
    identity?: CopilotAgentIdentity | null;
    inventory: WorkspaceInventory;
    /**
     * ALLOW-EDITS for THIS turn (spec D7.2) — carried per turn by the client,
     * never held as session state, so a mid-turn toggle or a reconnect cannot
     * leave the server and the dock disagreeing about the mode. Default false:
     * an omission gets the accept gate, the safe direction.
     */
    allowEdits?: boolean;
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
    // Claimed for the whole turn before anything can emit a thought.
    const turnIndex = this.turnIndex++;
    const abortController = new AbortController();
    this.abortController = abortController;

    const system = buildSystemPrompt({
      surface: opts.surface,
      draft: opts.draft,
      identity: opts.identity ?? null,
      inventory: opts.inventory,
    });
    const tools = buildToolSpecs(opts.surface);
    // Draft state the semantic checks run against (carries the surface) —
    // updated as the user accepts proposals so later calls in the same turn
    // see their effect.
    const draftState = draftStateFor(
      opts.surface,
      opts.draft,
      opts.identity ?? null,
    );
    this.messages.push({ role: "user", content: opts.message });

    let outputTokens = 0;
    try {
      for (let step = 0; step < this.deps.config.maxStepsPerTurn; step++) {
        abortController.signal.throwIfAborted();

        type ToolCall = { toolCallId: string; toolName: string; input: unknown };
        const toolCalls: ToolCall[] = [];
        let stepText = "";
        // One thought block per round-trip, keyed
        // `turn:<turnIndex>:step:<index>` — the chat rail's stepIndex
        // convention, PREFIXED by the turn because the dock upserts by key
        // globally: a bare `step:0` on the socket's second turn would replace
        // the first turn's thought in its old work block instead of opening a
        // new one. Its text is CUMULATIVE on the wire, so a dropped frame
        // self-heals on the next one; a provider that opens several reasoning
        // blocks in one step has them joined here rather than racing for the
        // same key.
        //
        // Reasoning is DISPLAY ONLY — it is never pushed back into `messages`.
        // That is correct while nothing asks for reasoning (see transport.ts),
        // but Anthropic's extended thinking + tool use requires the thinking
        // blocks to be echoed in the assistant turn: whoever turns thinking on
        // must round-trip them here as well, or the next request 400s.
        const thoughtKey = `turn:${turnIndex}:step:${step}`;
        let stepReasoning = "";
        let reasoningBlockId: string | null = null;

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
          } else if (part.type === "reasoning-delta") {
            if (reasoningBlockId !== null && reasoningBlockId !== part.id) {
              stepReasoning += "\n\n";
            }
            reasoningBlockId = part.id;
            stepReasoning += part.text;
            this.deps.send({
              type: "thought",
              key: thoughtKey,
              text: stepReasoning,
              streaming: true,
            });
          } else if (part.type === "tool-call") {
            toolCalls.push(part);
          } else if (part.type === "finish") {
            // Reasoning is billed output: when the provider reports usage it
            // already includes it, and when it does not the fallback estimate
            // must count it too or a thinking turn meters as a cheap one.
            outputTokens +=
              part.outputTokens ??
              Math.ceil((stepText.length + stepReasoning.length) / 4);
          }
        }
        // Seal the block: a later frame under this key would be the client's
        // cue that the same step resumed, which never happens.
        if (stepReasoning) {
          this.deps.send({
            type: "thought",
            key: thoughtKey,
            text: stepReasoning,
            streaming: false,
          });
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
        // proposal to the client, then pause until accepted/rejected (or, under
        // allow-edits, do not pause at all). The results message is pushed in
        // `finally` so an abort mid-proposal still pairs every tool call with a
        // (synthesized) result — see header invariant.
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
            // The step goes pending as its resolution BEGINS, not when the
            // call arrives: the loop resolves calls one at a time, and waiting
            // for the user is the long part — a later call must not claim to
            // be running while an earlier proposal is still on screen. A step
            // never sealed here (an abort mid-proposal) stays pending on the
            // wire and the client renders it canceled; the server has nothing
            // further to say about it.
            this.sendStep(call.toolCallId, call.toolName, "pending", null);
            const validation = validateMutation(
              call.toolName,
              call.input,
              opts.inventory,
              draftState,
            );
            let resultText: string;
            if (!validation.ok) {
              resultText = `INVALID TOOL CALL (not shown to the user): ${validation.message}. Fix the call and try again.`;
              // The PROBLEM is user-safe (it is built from this workspace's own
              // inventory); the model-facing wrapper above is not, and is not
              // what ships.
              this.sendStep(
                call.toolCallId,
                call.toolName,
                "error",
                validation.message,
              );
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
                ...(opts.allowEdits ? { autoApplied: true } : {}),
              });
              if (opts.allowEdits) {
                // Allow-edits: no park, no waiter registered — so a
                // `mutation_result` for this id finds nothing to resolve and is
                // ignored, exactly as the frame contract states. The client is
                // still the writer; it just was not asked first.
                applyAcceptedMutation(
                  draftState,
                  validation.tool,
                  validation.params,
                );
                resultText =
                  "accepted — allow-edits is on, so this change was applied to the draft immediately";
                this.sendStep(
                  call.toolCallId,
                  call.toolName,
                  "ok",
                  "Applied automatically",
                );
              } else {
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
                  resultText =
                    "accepted — the user applied this change to the draft";
                  this.sendStep(
                    call.toolCallId,
                    call.toolName,
                    "ok",
                    "Applied to the draft",
                  );
                } else {
                  resultText = `rejected — the user dismissed this proposal${result.reason ? `: ${result.reason}` : ""}`;
                  // `ok`, not `error`: dismissing a proposal is a decision the
                  // user made and the step completed on, not a failure. The
                  // copilot's step vocabulary has no `rejected` value — the
                  // proposal CARD carries that, this carries lifecycle only.
                  this.sendStep(
                    call.toolCallId,
                    call.toolName,
                    "ok",
                    result.reason
                      ? `Dismissed: ${result.reason}`
                      : "Dismissed by you",
                  );
                }
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

  /**
   * One tool step's lifecycle frame. The preview runs through the SAME
   * summarizer the chat thread uses (`summarizeToolResult`), so both surfaces
   * clamp and flatten identically and neither can drift into showing JSON.
   */
  private sendStep(
    key: string,
    toolName: string,
    state: CopilotStepState,
    preview: string | null,
  ): void {
    this.deps.send({
      type: "step",
      key,
      toolName,
      state,
      resultPreview: preview === null ? null : summarizeToolResult(preview),
    });
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
