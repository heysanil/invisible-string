/**
 * Per-source data-shape mappers (docs/PLAN.md Phase 3 task 3; INITIAL-SPEC.md
 * §8 step 2 "the trigger adapter converts raw inbound → TriggerEvent — raw
 * platform parsing lives ONLY here").
 *
 * These are PURE, I/O-FREE typed mappers: raw source event → the message/data/
 * continuation fields of a {@link TriggerEvent}. The control-plane dispatcher
 * wraps the result with `workflowId` + `principal` (identity/routing concerns
 * that are not part of the source payload) and POSTs the full envelope to the
 * compiled channel. Keeping them pure makes ingress fully unit-testable with no
 * network, DB, or clock dependency.
 *
 * Signature verification (Slack) and rate limits / payload caps live in the
 * ingress ROUTE, upstream of these mappers — never here.
 */
import type {
  SlackAppMentionEvent,
  SlackInnerEvent,
  SlackMessageEvent,
} from "./api";
import type { FormField } from "./workflow-definition";

/**
 * The source-agnostic slice of a {@link TriggerEvent} a mapper produces. The
 * dispatcher completes the envelope with `workflowId`, `principal`, and
 * (for Slack) resolves `continuationToken` from the thread mapping.
 */
export interface MappedTriggerData {
  /** Model-facing prompt / primary input. */
  message: string;
  /** Structured fields `@trigger.*` references resolve against. */
  data: Record<string, unknown>;
}

export type TriggerMapResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

// ── Slack ────────────────────────────────────────────────────────────────────

/** Reply routing captured from an inbound Slack event (compiled channel reads these). */
export interface SlackReplyTarget {
  channel: string;
  /** thread_ts when the message is threaded, else the message's own ts. */
  threadTs: string;
}

export interface SlackTriggerMapping extends MappedTriggerData {
  /**
   * Stable key the control plane maps to an agent_session (thread_ts of the
   * root, else the message ts). Same key ⇒ same session ⇒ threaded continuity.
   */
  threadKey: string;
  /** Where the terminal reply is posted (Slack Web API chat.postMessage). */
  replyTarget: SlackReplyTarget;
}

/** Slack renders app mentions as a leading `<@Uxxxxxxxx>` token; strip it. */
const LEADING_MENTION_RE = /^\s*<@[A-Z0-9]+>\s*/;

function cleanMentionText(text: string): string {
  return text.replace(LEADING_MENTION_RE, "").trim();
}

function isBotAuthored(
  event: SlackAppMentionEvent | SlackMessageEvent,
): boolean {
  return event.bot_id !== undefined;
}

/**
 * Subtypes that are NOT fresh user messages (edits, deletions, joins, bot
 * echoes). Mapping these would double-fire or loop, so the adapter ignores them.
 */
const IGNORED_MESSAGE_SUBTYPES = new Set<string>([
  "message_changed",
  "message_deleted",
  "channel_join",
  "channel_leave",
  "bot_message",
  "thread_broadcast",
]);

/**
 * Map a Slack inner event (app_mention / message.im / thread message) to
 * trigger data + reply target + thread key. Returns `ok: false` for events the
 * platform must ignore (bot echoes, edits, empty text) so the ingress route can
 * 200-ack without dispatching (Slack loop guard).
 */
export function slackEventToTriggerData(
  event: SlackInnerEvent,
): TriggerMapResult<SlackTriggerMapping> {
  if (isBotAuthored(event)) {
    return { ok: false, reason: "ignoring bot-authored event (loop guard)" };
  }

  if (event.type === "message") {
    if (event.subtype !== undefined && IGNORED_MESSAGE_SUBTYPES.has(event.subtype)) {
      return { ok: false, reason: `ignoring message subtype "${event.subtype}"` };
    }
    if (event.app_id !== undefined) {
      return { ok: false, reason: "ignoring app-authored message (loop guard)" };
    }
  }

  const rawText = event.type === "app_mention" ? event.text : (event.text ?? "");
  const message =
    event.type === "app_mention" ? cleanMentionText(rawText) : rawText.trim();
  if (message.length === 0) {
    return { ok: false, reason: "empty message text" };
  }

  const threadTs = event.thread_ts ?? event.ts;
  const data: Record<string, unknown> = {
    eventType: event.type,
    channel: event.channel,
    // The compiled Slack channel reads data.channel / data.thread_ts / data.ts
    // to build its reply target — keep these keys in the envelope.
    ts: event.ts,
    thread_ts: threadTs,
    text: message,
  };
  if (event.user !== undefined) data.user = event.user;
  if (event.team !== undefined) data.team = event.team;
  if (event.type === "message" && event.channel_type !== undefined) {
    data.channelType = event.channel_type;
  }

  return {
    ok: true,
    value: {
      message,
      data,
      threadKey: threadTs,
      replyTarget: { channel: event.channel, threadTs },
    },
  };
}

// ── Form ───────────────────────────────────────────────────────────────────

/**
 * Field keys whose value (when present) becomes the model-facing `message`.
 * Everything else is addressed via `@trigger.<key>` from the instructions.
 */
const FORM_MESSAGE_FIELD_KEYS = ["message", "prompt"] as const;

function coerceFormValue(field: FormField, raw: unknown): unknown {
  switch (field.type) {
    case "number": {
      if (typeof raw === "number") return raw;
      if (typeof raw === "string" && raw.trim() !== "") {
        const n = Number(raw);
        return Number.isNaN(n) ? raw : n;
      }
      return raw;
    }
    case "checkbox": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "on" || raw === 1) return true;
      if (raw === "false" || raw === "off" || raw === 0) return false;
      return raw;
    }
    default:
      // text / textarea / select / date pass through as-is (string-ish).
      return raw;
  }
}

/**
 * Map a submitted form (values keyed by field `key`) to trigger data, coercing
 * each declared field by its type and enforcing `required`. Unknown submitted
 * keys are dropped (the form schema is authoritative). `message` is taken from a
 * `message`/`prompt` field if the schema declares one, else "" (form triggers
 * carry content via `@trigger.<key>` refs). Pure.
 */
export function formSubmissionToTriggerData(
  fields: readonly FormField[],
  values: Record<string, unknown>,
): TriggerMapResult<MappedTriggerData> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const has = Object.prototype.hasOwnProperty.call(values, field.key);
    const raw = has ? values[field.key] : undefined;
    const missing =
      !has || raw === undefined || raw === null || raw === "";
    if (missing) {
      if (field.required) {
        return { ok: false, reason: `missing required field "${field.key}"` };
      }
      continue;
    }
    data[field.key] = coerceFormValue(field, raw);
  }

  let message = "";
  for (const key of FORM_MESSAGE_FIELD_KEYS) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) {
      message = value;
      break;
    }
  }

  return { ok: true, value: { message, data } };
}
