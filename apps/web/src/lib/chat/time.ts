/**
 * Time presentation for the chat surface: compact relative timestamps
 * ("now", "5m", "3h", "2d", then a short date) and recency buckets for the
 * session list ("Today" / "Yesterday" / "Previous 7 days" / "Earlier").
 */

export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export const RECENCY_GROUPS = [
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Earlier",
] as const;
export type RecencyGroup = (typeof RECENCY_GROUPS)[number];

export function recencyGroup(iso: string, now: Date = new Date()): RecencyGroup {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "Earlier";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (then >= startOfToday) return "Today";
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (then >= startOfYesterday) return "Yesterday";
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 7);
  if (then >= startOfWeek) return "Previous 7 days";
  return "Earlier";
}

/** Derive a compact thread title from the first user message. */
export function titleFromMessage(message: string, max = 64): string {
  const line = message.split("\n").find((part) => part.trim().length > 0) ?? "";
  const compact = line.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return "New conversation";
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}
