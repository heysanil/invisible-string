/**
 * Best-effort human-readable summary of a 5-field cron expression (minute
 * hour day-of-month month day-of-week) for the schedule trigger's preview.
 * Deliberately conservative: it recognises common shapes and otherwise
 * echoes the raw expression — eve's schedule compiler is the real validator.
 */
const DOW = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** "0 9 * * 1" → "At 09:00, on Monday". Returns null if it can't parse. */
export function describeCron(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  const time = describeTime(minute, hour);
  if (time === null) return null;

  // "Every N minutes / Every hour" already describe a cadence — only a
  // clock-time ("At HH:MM") reads naturally with a day qualifier.
  const isClockTime = time.startsWith("At ");

  if (dom === "*" && month === "*" && dow === "*") {
    return isClockTime ? `${time}, every day` : time;
  }
  if (!isClockTime) return time;

  const dayPhrases: string[] = [];
  if (dow !== "*") {
    const days = describeDow(dow);
    if (days === null) return time;
    dayPhrases.push(`on ${days}`);
  }
  if (dom !== "*") dayPhrases.push(`on day ${dom} of the month`);

  return dayPhrases.length > 0 ? `${time}, ${dayPhrases.join(", ")}` : time;
}

function describeTime(minute: string, hour: string): string | null {
  // Every-N-minutes shorthand.
  const stepMinute = /^\*\/(\d+)$/.exec(minute);
  if (stepMinute && hour === "*") {
    return `Every ${stepMinute[1]} minutes`;
  }
  if (minute === "*" && hour === "*") return "Every minute";
  if (hour === "*") {
    const m = Number(minute);
    if (Number.isInteger(m) && m >= 0 && m <= 59) {
      return `Every hour at :${pad(m)}`;
    }
    return null;
  }
  const h = Number(hour);
  const m = Number(minute);
  if (
    Number.isInteger(h) &&
    Number.isInteger(m) &&
    h >= 0 &&
    h <= 23 &&
    m >= 0 &&
    m <= 59
  ) {
    return `At ${pad(h)}:${pad(m)}`;
  }
  return null;
}

function describeDow(dow: string): string | null {
  const names = dow.split(",").map((token) => {
    const n = Number(token);
    // cron allows 0 and 7 for Sunday.
    if (!Number.isInteger(n) || n < 0 || n > 7) return null;
    return DOW[n === 7 ? 0 : n];
  });
  if (names.some((name) => name === null)) return null;
  return names.join(", ");
}
