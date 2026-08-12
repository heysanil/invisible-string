/**
 * Session titler — the generated thread names in the chat sidebar
 * (2026-08-11 lifecycle spec, decision D9).
 *
 * `agent_sessions.title` starts NULL and is filled once, in the background,
 * after the thread's FIRST user message. Three properties are load-bearing:
 *
 * 1. **It never touches the request path.** `kickSessionTitle` is a `void`
 *    fire-and-forget in the style of the after-create connection probe
 *    (resources/connections.ts): the caller neither awaits it nor can fail
 *    from it. Every failure inside — no platform key, no `quick` preset, a
 *    model timeout, a garbage completion, a dead DB — resolves to "the row
 *    keeps its NULL title" plus one log line. D9 is explicit that titling
 *    failure is SILENT; the client falls back to truncating the first message
 *    (`titleFromMessage`), never to rendering "Untitled".
 * 2. **It calls the model exactly the way the copilot does.** Provider
 *    construction mirrors copilot/transport.ts — lazily built so a keyless
 *    boot never throws `AI_LoadAPIKeyError`, `OPENROUTER_BASE_URL` honored so
 *    harnesses can point it at a stub. The differences are deliberate and
 *    small: one non-streaming `generateText` round-trip with no tools; the
 *    model is the workspace's **quick** preset (`model_presets.slug =
 *    'quick'`) **at the preset's own reasoning effort** rather than the
 *    copilot's Claude, since a title is the cheapest possible ask — and quick
 *    is only cheaper than balanced BECAUSE of the effort (the two seed to the
 *    same model id; packages/db seed.ts says so); and both the keys and the
 *    SESSION_TITLE_* switch come from the RUNTIME CONFIG the stack was built
 *    with, not a fresh `process.env` read (see {@link TitleRuntimeConfig}).
 * 3. **Raw model output never reaches the column.** `sanitizeSessionTitle`
 *    takes the first line, unwraps the quotes/markdown/`Title:` preambles
 *    models reliably add, drops trailing punctuation, and clamps to shared
 *    `SESSION_TITLE_MAX_CHARS` on a word boundary. A model that answers the
 *    message instead of titling it, or that returns the sentinel `NONE` for a
 *    contentless opener ("hi"), yields null — no title, fallback renders.
 *
 * The preset's effort rides ai@7's own top-level `reasoning` call option — the
 * only route a DIRECT SDK call has, and honored by exactly one of the two
 * providers on the control plane's pins today ({@link generateTitleWithModel}
 * spells out which and why). AGENTS.md's `extraBody` rule is about the
 * COMPILED AGENT's `@openrouter/ai-sdk-provider@3.0.0` pin
 * (packages/compiler/versions.json), not this process's 6.0.0-alpha.1 one.
 * `maxOutputTokens` is set well above what a title needs precisely because a
 * reasoning model spends output tokens thinking before it writes one.
 */
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  SESSION_TITLE_MAX_CHARS,
  type Logger,
  type ReasoningEffort,
} from "@invisible-string/shared";

import type { Db } from "../db";

// ── configuration ────────────────────────────────────────────────────────────

export interface SessionTitleConfig {
  /** SESSION_TITLE_ENABLED=0 turns titling off outright (operator switch). */
  enabled: boolean;
  /** Wall-clock cap on the model round-trip (SESSION_TITLE_TIMEOUT_MS). */
  timeoutMs: number;
}

/**
 * The platform credentials one title round-trip may use. Deliberately the
 * RuntimeConfig fields rather than a second `process.env` read: `createAppStack`
 * takes an env RECORD and every in-process harness injects one, so reading the
 * ambient environment here would let a developer's exported OPENROUTER_API_KEY
 * turn an offline test run into real, billable provider traffic.
 */
export interface TitleProviderKeys {
  openrouterApiKey?: string;
  anthropicApiKey?: string;
  /** OPENROUTER_BASE_URL override (harnesses point this at a stub). */
  openrouterBaseUrl?: string;
}

/**
 * The slice of the stack's runtime config the titler reads: the platform keys
 * AND the SESSION_TITLE_* switch, from the ONE env record `createAppStack` was
 * constructed with. The switch belongs here for the same reason the keys do —
 * a harness that injects a runtime key and sets `SESSION_TITLE_ENABLED=0` in
 * the same record must not have the second half of that pair ignored, or it
 * bills a real provider call it explicitly asked not to make.
 */
export interface TitleRuntimeConfig extends TitleProviderKeys {
  /** `loadSessionTitleConfig(env)` for the stack's env record. */
  sessionTitle?: SessionTitleConfig;
}

/**
 * Output-token budget for one title. Far more than a six-word title needs: a
 * model whose provider default is "think first" burns this budget on reasoning
 * tokens, and a cap that only fits the title would return an empty completion.
 */
const TITLE_MAX_OUTPUT_TOKENS = 256;

/** Model-input clamp on the user's first message (bounds prompt cost). */
const TITLE_INPUT_MAX_CHARS = 4_000;

/** Sentinel the prompt asks for when a message carries nothing to title. */
const TITLE_NONE = "NONE";

const TITLE_SYSTEM_PROMPT = [
  "You label chat threads. You are given the first message a user sent to an AI agent.",
  "Reply with a title of at most six words naming the specific task or topic.",
  "",
  "Rules:",
  "- Reply with the title alone: no quotes, no markdown, no trailing punctuation, no preamble.",
  "- Never answer the message, never ask a question, never address the user.",
  "- Be specific: name the thing, not the genre ('Refund policy for EU orders', not 'A question').",
  "- Write it in the language of the message.",
  `- If the message carries nothing to title (a greeting, a test, an empty prompt), reply with exactly: ${TITLE_NONE}`,
].join("\n");

export function loadSessionTitleConfig(
  env: Record<string, string | undefined> = process.env,
): SessionTitleConfig {
  const explicit = env.SESSION_TITLE_ENABLED?.trim();
  const rawTimeout = Number(env.SESSION_TITLE_TIMEOUT_MS?.trim());
  return {
    // On by default in a real deployment (a workspace with no platform key
    // simply never titles), OFF by default under `bun test`: an integration
    // suite that constructs the stack with a dummy provider key must not make
    // an unmocked provider call in the background of an unrelated assertion.
    // Setting SESSION_TITLE_ENABLED=1 forces it on even there (keyed lanes).
    enabled: explicit ? explicit !== "0" : env.NODE_ENV !== "test",
    timeoutMs:
      Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : 15_000,
  };
}

// ── deps + parameters ────────────────────────────────────────────────────────

/** The provider + model + effort one title round-trip runs against. */
export interface TitleModelRef {
  provider: "anthropic" | "openrouter";
  modelId: string;
  /**
   * The preset's reasoning effort. Load-bearing, not decoration: the seeded
   * `quick` and `balanced` presets are THE SAME MODEL ID and differ only here
   * (packages/db/src/seed.ts), so dropping it would run titling at balanced's
   * cost/latency profile under quick's name.
   */
  reasoning: ReasoningEffort;
}

export interface TitleGeneratorInput {
  model: TitleModelRef;
  /** The user's first message, verbatim (clamped by the generator). */
  message: string;
  keys: TitleProviderKeys;
  signal: AbortSignal;
}

/** One model round-trip returning the RAW completion (sanitized by us). */
export type TitleGenerator = (
  input: TitleGeneratorInput,
) => Promise<string | null>;

/**
 * Structural deps — `RuntimeDeps` and `ResourceDeps` both satisfy this without
 * carrying the test seams, which are optional precisely so no production wiring
 * has to know they exist.
 */
export interface SessionTitlerDeps {
  db: Db;
  logger: Logger;
  /**
   * The runtime config's platform keys + titling switch (`RuntimeDeps.runtime`
   * satisfies this as-is). Absent — an unconfigured runtime — means no titles,
   * never an error.
   */
  runtime?: TitleRuntimeConfig;
  /** Test seam: replaces the model round-trip. */
  generateTitle?: TitleGenerator;
  /** Test seam: wins over `runtime.sessionTitle` (focused fixtures). */
  sessionTitleConfig?: SessionTitleConfig;
}

export interface SessionTitleParams {
  organizationId: string;
  sessionId: string;
  /** The thread's first user message. */
  message: string;
}

// ── the fire-and-forget entry point ──────────────────────────────────────────

/**
 * Kick a background title for a freshly created session. Returns void by
 * design: there is nothing a caller could usefully do with the outcome, and
 * anything awaited here would put a model round-trip in front of the user's
 * first message.
 */
export function kickSessionTitle(
  deps: SessionTitlerDeps,
  params: SessionTitleParams,
): void {
  void generateAndPersistSessionTitle(deps, params).catch((error) => {
    // Belt-and-braces: the body already swallows model/DB failures. This
    // catches anything it did not anticipate so an unhandled rejection can
    // never take the process down over a cosmetic title.
    deps.logger.warn("session.title_failed", {
      workspaceId: params.organizationId,
      sessionId: params.sessionId,
      err: error,
    });
  });
}

/**
 * Generate + persist a title for one session. Resolves to the persisted title,
 * or null for every "no title" outcome (disabled, no preset, no key, model
 * failure/timeout, unusable completion, row already titled). Never rejects on
 * a model failure — only a genuinely unexpected fault (e.g. the DB write)
 * escapes, and {@link kickSessionTitle} catches that.
 *
 * Exported for tests, which await it; production callers use the kick.
 */
export async function generateAndPersistSessionTitle(
  deps: SessionTitlerDeps,
  params: SessionTitleParams,
): Promise<string | null> {
  // The stack's OWN environment decides, never the ambient one: an injected
  // env record's kill switch is the only thing standing between an offline
  // harness that also injects a runtime key and a real, billed provider call.
  // The `process.env` read is a last resort for focused fixtures that wire
  // neither (see the wiring note on TitleRuntimeConfig).
  const config =
    deps.sessionTitleConfig ??
    deps.runtime?.sessionTitle ??
    loadSessionTitleConfig();
  if (!config.enabled) return null;
  if (!params.message.trim()) return null;

  const model = await resolveQuickPresetModel(deps.db, params.organizationId);
  if (!model) {
    // A workspace whose seeds never ran (or whose admin deleted the preset).
    deps.logger.debug("session.title_skipped", {
      workspaceId: params.organizationId,
      sessionId: params.sessionId,
      fields: { reason: "no_quick_preset" },
    });
    return null;
  }

  const generate = deps.generateTitle ?? generateTitleWithModel;
  // Own the timer rather than using AbortSignal.timeout: a settled round-trip
  // must not leave a pending timer holding the event loop open in tests.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let raw: string | null;
  try {
    raw = await generate({
      model,
      message: params.message,
      keys: deps.runtime ?? {},
      signal: controller.signal,
    });
  } catch (error) {
    // Timeouts, provider errors, missing keys — all the same outcome.
    deps.logger.warn("session.title_failed", {
      workspaceId: params.organizationId,
      sessionId: params.sessionId,
      fields: { modelId: model.modelId },
      err: error,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }

  const title = raw === null ? null : sanitizeSessionTitle(raw);
  if (!title) return null;

  // Workspace-scoped write even on a background path (golden rule 7), and
  // `title IS NULL` makes it single-shot: a racing second kick or a title set
  // by any other means is never clobbered. This bumps `updated_at` (the
  // schema's $onUpdate), nudging the session's lastActivityAt by the titling
  // latency — immaterial for a thread created seconds ago.
  const updated = await deps.db
    .update(schema.agentSessions)
    .set({ title })
    .where(
      and(
        eq(schema.agentSessions.id, params.sessionId),
        eq(schema.agentSessions.organizationId, params.organizationId),
        isNull(schema.agentSessions.title),
      ),
    )
    .returning({ id: schema.agentSessions.id });

  if (updated.length === 0) return null;
  deps.logger.debug("session.titled", {
    workspaceId: params.organizationId,
    sessionId: params.sessionId,
  });
  return title;
}

/**
 * The workspace's `quick` preset as a model reference — provider, model id AND
 * effort, because the preset's identity is all three (a `quick` row that lost
 * its `low` is just `balanced`). Null when the workspace has no such row —
 * titling is skipped rather than falling back to another preset, because
 * "quick" is the only one D9 authorizes to spend the platform key on
 * background work.
 */
export async function resolveQuickPresetModel(
  db: Db,
  organizationId: string,
): Promise<TitleModelRef | null> {
  const rows = await db
    .select({
      provider: schema.modelPresets.provider,
      modelId: schema.modelPresets.modelId,
      reasoning: schema.modelPresets.reasoning,
    })
    .from(schema.modelPresets)
    .where(
      and(
        eq(schema.modelPresets.organizationId, organizationId),
        eq(schema.modelPresets.slug, "quick"),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row
    ? {
        provider: row.provider,
        modelId: row.modelId,
        reasoning: row.reasoning,
      }
    : null;
}

// ── the model round-trip ─────────────────────────────────────────────────────

/**
 * The AI SDK's own effort union (`LanguageModelV4CallOptions["reasoning"]` in
 * @ai-sdk/provider@4) tops out at `xhigh`, so the platform's `max` clamps
 * there — the same clamp the compiler's anthropic branch makes, for the same
 * reason: both mean "spend the most". `provider-default` returns undefined so
 * the field is omitted entirely (distinct from an explicit `"none"`).
 */
export function titleReasoningEffort(
  effort: ReasoningEffort,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (effort === "provider-default") return undefined;
  return effort === "max" ? "xhigh" : effort;
}

/**
 * One non-streaming completion against the resolved model. Returns null when
 * the provider's platform key is absent — a keyless deployment must not throw
 * here, it simply has no titles (same stance the copilot takes by not mounting
 * its socket at all).
 *
 * REASONING EFFORT rides ai@7's top-level `reasoning` call setting, which is
 * the only route a direct SDK call has. Honored per provider, verified against
 * the pins in apps/control-plane/package.json — do not assume symmetry:
 * - `@ai-sdk/anthropic@4.0.7` is spec-v4 and its `getArgs()` DOES destructure
 *   `reasoning`, mapping it onto a thinking budget/effort. It lands.
 * - `@openrouter/ai-sdk-provider@6.0.0-alpha.1` does NOT. Its chat model
 *   builds a whitelisted Responses-API body (model/input/stream/
 *   maxOutputTokens/temperature/topP/tools/toolChoice/text), so this option is
 *   dropped — and so would `extraBody` be (the provider stores that setting
 *   and never reads it on this line). copilot/transport.ts documents the same
 *   ceiling. We still ASK: it costs nothing, it is the SDK-blessed route, and
 *   it starts landing the day the pin moves. Note AGENTS.md's "effort must
 *   ride extraBody" rule is about the COMPILED AGENT's 3.0.0 pin
 *   (packages/compiler/versions.json), where extraBody genuinely is spread
 *   over the body — that mechanism does not exist here.
 */
const generateTitleWithModel: TitleGenerator = async ({
  model,
  message,
  keys,
  signal,
}) => {
  // Model construction is lazy for the same reason as copilot/transport.ts:
  // `openrouter(slug)` raises AI_LoadAPIKeyError at construction time.
  const languageModel = (() => {
    if (model.provider === "anthropic") {
      if (!keys.anthropicApiKey) return null;
      return createAnthropic({ apiKey: keys.anthropicApiKey })(model.modelId);
    }
    if (!keys.openrouterApiKey) return null;
    return createOpenRouter({
      apiKey: keys.openrouterApiKey,
      ...(keys.openrouterBaseUrl ? { baseURL: keys.openrouterBaseUrl } : {}),
    })(model.modelId);
  })();
  if (!languageModel) return null;

  const reasoning = titleReasoningEffort(model.reasoning);
  const result = await generateText({
    model: languageModel,
    system: TITLE_SYSTEM_PROMPT,
    prompt: `First message in the thread:\n\n${message.slice(0, TITLE_INPUT_MAX_CHARS)}`,
    maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
    ...(reasoning ? { reasoning } : {}),
    abortSignal: signal,
  });
  return result.text;
};

// ── sanitization ─────────────────────────────────────────────────────────────

/** Wrappers models put around a title, longest-first so `**"x"**` unwraps. */
const TITLE_WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ["**", "**"],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["«", "»"],
  ["*", "*"],
  ["_", "_"],
];

function unwrapOnce(value: string): string {
  for (const [open, close] of TITLE_WRAPPERS) {
    if (
      value.length > open.length + close.length &&
      value.startsWith(open) &&
      value.endsWith(close)
    ) {
      return value.slice(open.length, value.length - close.length).trim();
    }
  }
  return value;
}

/**
 * Raw completion → a title fit for the column, or null when there is nothing
 * usable in it. Pure; every rule here exists because a model does the thing:
 * heading markers, `Title: …` preambles, layered quotes/bold, a trailing full
 * stop, and the multi-line "Sure! Here's a title:\n\n**X**" shape (the first
 * NON-empty line wins, which is why the preamble strip runs after the split).
 */
export function sanitizeSessionTitle(raw: string): string | null {
  // Bound the work before any regex runs: a runaway completion is still just
  // text we are about to discard.
  const head = raw.slice(0, 500);
  const lines = head
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const [index, line] of lines.entries()) {
    // "Sure, here's a title:" — a line ending in a colon with content after it
    // is a preamble, not the title. Without this the preamble WINS (stripping
    // its trailing colon leaves a perfectly "valid" 5-word string).
    if (line.endsWith(":") && index < lines.length - 1) continue;
    const title = sanitizeTitleLine(line);
    if (title) return title;
  }
  return null;
}

function sanitizeTitleLine(line: string): string | null {
  let title = line
    .replace(/^#{1,6}\s*/, "") // markdown heading
    .replace(/^[-*>]\s+/, "") // list item / block quote
    .replace(/^(?:chat |thread |suggested )?title\s*[:\-—]\s*/i, "")
    .trim();

  // Layered wrappers: **"Refund policy"** unwraps in two passes; three is
  // slack for a model that also backticks it.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = unwrapOnce(title);
    if (next === title) break;
    title = next;
  }

  title = title
    // Control characters (a stray tab or DEL) collapse into spaces.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Trailing punctuation the model adds; `?` and `!` survive because a
    // question genuinely is a title ("Why is the build slow?").
    .replace(/[\s.,;:…—-]+$/u, "")
    .trim();

  if (!title) return null;
  if (title.toUpperCase() === TITLE_NONE) return null;
  // Punctuation-only leftovers ("---", "…") are not titles.
  if (!/[\p{L}\p{N}]/u.test(title)) return null;

  return clampSessionTitle(title);
}

/**
 * Clamp to the shared budget on a word boundary, marking the cut with an
 * ellipsis. The ellipsis is inside the budget, so the result is always ≤
 * SESSION_TITLE_MAX_CHARS and the DTO's `.max()` can never reject it.
 */
function clampSessionTitle(title: string): string {
  if (title.length <= SESSION_TITLE_MAX_CHARS) return title;
  const cut = title.slice(0, SESSION_TITLE_MAX_CHARS - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // Only respect a word boundary in the back half — one 70-character "word"
  // must not truncate to nothing.
  const body =
    lastSpace >= Math.floor(SESSION_TITLE_MAX_CHARS / 2)
      ? cut.slice(0, lastSpace)
      : cut;
  return `${body.replace(/[\s.,;:…—-]+$/u, "")}…`;
}
