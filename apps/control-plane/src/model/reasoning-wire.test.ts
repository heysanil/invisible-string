/**
 * WIRE TEST — the control plane's own answer to the question
 * `packages/compiler/src/wire-probe.mjs` asks of the COMPILED AGENT: does the
 * reasoning effort we resolve actually reach the provider's request body?
 *
 * It exists because the drift it guards was invisible to every test we had.
 * `session-title.test.ts` stubs the whole `TitleGenerator`, so it proves the
 * effort reaches `generateTitleWithModel`'s INPUT — but that function is the
 * only code here that touches the SDK, and it was never executed. The seam sat
 * ABOVE the provider, so a provider that silently dropped the option stayed
 * green for months while every title ran at the model's default effort.
 *
 * So these assert on BYTES: a stub gateway captures the POST body and the test
 * reads `reasoning.effort` out of it. Two properties are load-bearing and both
 * are asserted, because only the pair proves the mechanism:
 *
 *  1. the effort IS in the body (the fix works), and
 *  2. it is NOT there when it rides ai@7's top-level `reasoning` CALL OPTION
 *     (`callOptionIsStillDropped`) — spike finding 29, re-proven against the
 *     control plane's own pin rather than inherited from the compiler's. That
 *     negative is the whole reason `extraBody` is the route; if it ever flips,
 *     this test says so and the `extraBody` detour can be retired.
 *
 * The Anthropic branch is wire-tested too, at the bottom: it needs no escape
 * hatch (its `getArgs()` DOES destructure the call option), but the two things
 * that branch owns are worth pinning on bytes anyway — the `max` -> `xhigh`
 * clamp, and the `none` (thinking disabled) vs `provider-default` (no thinking
 * block at all) distinction that the whole 8-value vocabulary rests on.
 */
import { describe, expect, test } from "bun:test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { ReasoningEffort } from "@invisible-string/shared";

import { generateTitleWithModel } from "../resources/session-title";
import { createModelTransport } from "../copilot/transport";
import { loadCopilotConfig } from "../copilot/config";
import { anthropicReasoningEffort } from "./reasoning";

// ── stub gateway ─────────────────────────────────────────────────────────────

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

/**
 * A minimal OpenAI-compatible gateway that records every request body. `port:
 * 0` + `idleTimeout: 0` are the house pattern (see oauth/broker.test.ts): an
 * OS-assigned port cannot collide with a parallel suite, and Bun's default
 * 10 s idle timeout would cut a streaming response mid-flight.
 */
function stubGateway(streaming: boolean) {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      captured.push({
        path: url.pathname,
        body: (await req.json()) as Record<string, unknown>,
      });
      if (!streaming) {
        return Response.json({
          id: "wire",
          object: "chat.completion",
          created: 0,
          model: "wire",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Refund policy" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      // Smallest SSE transcript the provider will parse into one text delta
      // plus a clean finish. A malformed body here would surface as a stream
      // error and mask the request we came for.
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "wire",
          object: "chat.completion.chunk",
          created: 0,
          model: "wire",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      return new Response(
        `${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    captured,
    baseUrl: `http://127.0.0.1:${server.port}/api/v1`,
    [Symbol.dispose]: () => void server.stop(true),
  };
}

/** `reasoning` as the gateway saw it, or undefined when it never arrived. */
function wireEffort(captured: Captured[]): unknown {
  expect(captured.length).toBe(1);
  return (captured[0]!.body as { reasoning?: unknown }).reasoning;
}

// ── the titler ───────────────────────────────────────────────────────────────

describe("session titler → OpenRouter wire body", () => {
  test("the resolved effort reaches the request body", async () => {
    using gw = stubGateway(false);
    const title = await generateTitleWithModel({
      model: {
        provider: "openrouter",
        modelId: "~deepseek/deepseek-v4-flash-latest",
        reasoning: "low",
      },
      message: "How do refunds work?",
      keys: {
        openrouterApiKey: "wire-key",
        anthropicApiKey: undefined,
        openrouterBaseUrl: gw.baseUrl,
      },
      signal: AbortSignal.timeout(10_000),
    });

    expect(title).toBe("Refund policy");
    expect(wireEffort(gw.captured)).toEqual({ effort: "low" });
  });

  test("`max` is NOT clamped on OpenRouter — it is sent verbatim", async () => {
    // The clamp to `xhigh` belongs to the Anthropic branch, whose SDK union
    // tops out there. OpenRouter's own API accepts `max` and answers it with
    // materially more reasoning (AGENTS.md: 5.8x the tokens of `low` on
    // kimi-k3), so clamping here would silently downgrade the top setting.
    using gw = stubGateway(false);
    await generateTitleWithModel({
      model: { provider: "openrouter", modelId: "moonshotai/kimi-k3", reasoning: "max" },
      message: "hi",
      keys: {
        openrouterApiKey: "wire-key",
        anthropicApiKey: undefined,
        openrouterBaseUrl: gw.baseUrl,
      },
      signal: AbortSignal.timeout(10_000),
    });
    expect(wireEffort(gw.captured)).toEqual({ effort: "max" });
  });

  test("`provider-default` sends no reasoning block at all", async () => {
    // Distinct from `none`: ~1/3 of catalog models advertise no reasoning
    // support, and for those an omitted block is the only verified behaviour.
    using gw = stubGateway(false);
    await generateTitleWithModel({
      model: {
        provider: "openrouter",
        modelId: "x/no-reasoning",
        reasoning: "provider-default",
      },
      message: "hi",
      keys: {
        openrouterApiKey: "wire-key",
        anthropicApiKey: undefined,
        openrouterBaseUrl: gw.baseUrl,
      },
      signal: AbortSignal.timeout(10_000),
    });
    expect(wireEffort(gw.captured)).toBeUndefined();
  });
});

// ── the copilot ──────────────────────────────────────────────────────────────

describe("copilot transport → OpenRouter wire body", () => {
  async function drain(transport: ReturnType<typeof createModelTransport>) {
    for await (const _ of transport.stream({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      abortSignal: AbortSignal.timeout(10_000),
      maxOutputTokens: 64,
    })) {
      // The parts themselves are covered by the copilot suite; here we only
      // need the round-trip to complete so the gateway has seen the body.
    }
  }

  test("a configured effort reaches the request body", async () => {
    using gw = stubGateway(true);
    const config = loadCopilotConfig({
      COPILOT_REASONING_EFFORT: "high",
      OPENROUTER_BASE_URL: gw.baseUrl,
    });
    await drain(createModelTransport(config, { OPENROUTER_API_KEY: "wire-key" }));
    expect(wireEffort(gw.captured)).toEqual({ effort: "high" });
  });

  test("the default config sends no reasoning block — copilot cost is unchanged", async () => {
    // The field defaults to `provider-default`, so simply adopting this
    // release must not start billing reasoning tokens on every copilot turn.
    using gw = stubGateway(true);
    const config = loadCopilotConfig({ OPENROUTER_BASE_URL: gw.baseUrl });
    await drain(createModelTransport(config, { OPENROUTER_API_KEY: "wire-key" }));
    expect(wireEffort(gw.captured)).toBeUndefined();
  });
});

// ── the negative that justifies `extraBody` ──────────────────────────────────

describe("ai@7's top-level `reasoning` call option on OpenRouter", () => {
  test("is STILL dropped by @openrouter/ai-sdk-provider@3.0.0", async () => {
    // Spike finding 29, re-proven against THIS process's pin. This is why the
    // effort rides `settings.extraBody` rather than the SDK-blessed call
    // option: the provider's `getArgs()` never destructures `reasoning`.
    //
    // If this test ever fails, the provider started honouring the call option
    // and `model/reasoning.ts`'s OpenRouter branch can be deleted in favour of
    // the same top-level option the Anthropic branch already uses.
    using gw = stubGateway(false);
    const model = createOpenRouter({
      apiKey: "wire-key",
      baseURL: gw.baseUrl,
    })("x/y");

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      reasoning: "low",
    } as never);

    expect(wireEffort(gw.captured)).toBeUndefined();
  });
});

// ── the Anthropic route ──────────────────────────────────────────────────────

describe("anthropicReasoningEffort → Anthropic wire body", () => {
  /**
   * Asserted against the ROUTE rather than through a call site, because
   * neither caller accepts an Anthropic base URL: `session-title.ts` and
   * `copilot/transport.ts` both build `createAnthropic({ apiKey })` with no
   * `baseURL` (only the OpenRouter branch honours one, via
   * OPENROUTER_BASE_URL). That is fine — the Anthropic path is implemented but
   * inactive in this deployment, and each call site applies the helper in
   * three lines that typecheck — but it does mean the stub-gateway trick can
   * only reach the mapping, not the wiring. If an ANTHROPIC_BASE_URL is ever
   * added, fold these into the caller-level describes above.
   */
  function anthropicGateway() {
    const captured: Captured[] = [];
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        captured.push({
          path: new URL(req.url).pathname,
          body: (await req.json()) as Record<string, unknown>,
        });
        return Response.json({
          id: "msg_wire",
          type: "message",
          role: "assistant",
          model: "wire",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    return {
      captured,
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      [Symbol.dispose]: () => void server.stop(true),
    };
  }

  /** `output_config.effort` as the gateway saw it — where ai@7's top-level
   *  `reasoning` option lands once @ai-sdk/anthropic has mapped it. */
  async function wireBody(effort: ReasoningEffort) {
    using gw = anthropicGateway();
    const reasoning = anthropicReasoningEffort(effort);
    await generateText({
      model: createAnthropic({ apiKey: "wire-key", baseURL: gw.baseUrl })(
        "claude-opus-4-8",
      ),
      prompt: "hi",
      maxOutputTokens: 64,
      ...(reasoning ? { reasoning } : {}),
    });
    expect(gw.captured.length).toBe(1);
    return gw.captured[0]!.body as {
      thinking?: unknown;
      output_config?: { effort?: string };
    };
  }

  test("the effort lands on the request as output_config.effort", async () => {
    // Unlike OpenRouter, this needs no escape hatch: the provider destructures
    // the call option and maps it onto adaptive thinking plus an effort.
    const body = await wireBody("low");
    expect(body.output_config?.effort).toBe("low");
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  test("`max` reaches the wire as `xhigh` — the clamp, end to end", async () => {
    // The counterpart to the OpenRouter case above, which sends `max`
    // VERBATIM. Here `xhigh` is the top of the call-option union, and the
    // provider maps it onward to the model's own maximum.
    expect((await wireBody("max")).output_config?.effort).toBe("xhigh");
  });

  test("`none` DISABLES thinking, and is not the same as omitting it", async () => {
    // The distinction `provider-default` exists to preserve: an explicit
    // `none` turns reasoning off on the wire...
    const none = await wireBody("none");
    expect(none.thinking).toEqual({ type: "disabled" });

    // ...while `provider-default` sends no thinking block at all, which is the
    // only verified behaviour for a model advertising no reasoning support.
    const dflt = await wireBody("provider-default");
    expect(dflt.thinking).toBeUndefined();
    expect(dflt.output_config).toBeUndefined();
  });
});
