/** ANSI colors for the three app-log prefixes. */
export const PREFIX_COLORS = {
  api: "\x1b[36m", // cyan
  worker: "\x1b[35m", // magenta
  web: "\x1b[32m", // green
} as const;

const RESET = "\x1b[0m";

/**
 * Line-buffered prefixer: feed raw chunks, receive complete lines prefixed
 * `tag   │ …`. Partial lines are held across chunks; flush() drains the
 * remainder (a child that died mid-line).
 */
export function createLinePrefixer(
  tag: string,
  color: string,
  width = 6,
): { push(chunk: string): string[]; flush(): string[] } {
  const prefix = `${color}${tag.padEnd(width)}│${RESET} `;
  let partial = "";
  const format = (line: string): string =>
    prefix + (line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    push(chunk: string): string[] {
      const parts = (partial + chunk).split("\n");
      partial = parts.pop() ?? "";
      return parts.map(format);
    },
    flush(): string[] {
      if (partial === "") return [];
      const line = format(partial);
      partial = "";
      return [line];
    },
  };
}
