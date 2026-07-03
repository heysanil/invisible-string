/**
 * Slack Web API outbound helper (generated; inlined because generated projects
 * cannot depend on workspace packages). The compiled Slack trigger channel
 * calls postSlackReply() from its message.completed handler to post the
 * agent's terminal reply back to the originating thread.
 *
 * Credentials + endpoint come from the agent process env (injected by the
 * control-plane dispatcher / worker supervisor, never baked into code):
 * - SLACK_BOT_TOKEN     the team's bot token (xoxb-…)
 * - SLACK_API_BASE_URL  Slack Web API base (default https://slack.com/api;
 *                       tests point it at a stub server)
 */
export interface SlackReplyTarget {
  channel: string | null;
  threadTs: string | null;
}

/** Extract the reply channel + thread from an inbound Slack event's data. */
export function replyTargetFrom(data: Record<string, unknown>): SlackReplyTarget {
  const channel = typeof data.channel === "string" ? data.channel : null;
  const threadTs =
    typeof data.thread_ts === "string"
      ? data.thread_ts
      : typeof data.ts === "string"
        ? data.ts
        : null;
  return { channel, threadTs };
}

export interface PostSlackReplyOptions {
  /** Bot token; defaults to process.env.SLACK_BOT_TOKEN. */
  token?: string;
  /** Slack Web API base; defaults to SLACK_API_BASE_URL or slack.com. */
  apiBaseUrl?: string;
  /** Injected fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface PostSlackReplyResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_SLACK_API_BASE_URL = "https://slack.com/api";

/**
 * Post the reply text to target.channel (threaded when target.threadTs is set)
 * via chat.postMessage. Never throws — delivery failures are logged and
 * returned as { ok: false } so a failed reply cannot crash the agent turn.
 */
export async function postSlackReply(
  target: SlackReplyTarget,
  text: string,
  options: PostSlackReplyOptions = {},
): Promise<PostSlackReplyResult> {
  const token = options.token ?? process.env.SLACK_BOT_TOKEN;
  if (token === undefined || token.length === 0) {
    console.error("[slack] SLACK_BOT_TOKEN is not set; dropping outbound reply");
    return { ok: false, error: "missing_token" };
  }
  if (target.channel === null) {
    console.error("[slack] no reply channel recorded; dropping outbound reply");
    return { ok: false, error: "missing_channel" };
  }
  const base = (
    options.apiBaseUrl ??
    process.env.SLACK_API_BASE_URL ??
    DEFAULT_SLACK_API_BASE_URL
  ).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(base + "/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        channel: target.channel,
        text,
        ...(target.threadTs !== null ? { thread_ts: target.threadTs } : {}),
      }),
    });
    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (result === null || result.ok !== true) {
      const error = result?.error ?? "HTTP " + String(response.status);
      console.error("[slack] chat.postMessage failed: " + error);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (error) {
    console.error("[slack] chat.postMessage failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
