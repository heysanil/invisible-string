/**
 * Pure 5-field UTC cron evaluator — the schedule ticker's clock and the real
 * validator behind the shared `cronExpressionSchema` shape check (which only
 * guards "five whitespace-separated fields"). Internal by design: no cron
 * dependency enters the tree for four grammar rules and a date walk.
 *
 * Grammar (per field, comma-separated list of items):
 *   `*`       every value
 *   `*\/n`    every n-th value from the field minimum (no backslash — JSDoc
 *             cannot spell the two characters star-slash inside a comment)
 *   `a`       one value
 *   `a-b`     inclusive range (a <= b; no wraparound)
 *   `a-b/n`   every n-th value within the range
 *
 * Fields + ranges: minute 0-59 · hour 0-23 · day-of-month 1-31 · month 1-12 ·
 * day-of-week 0-7 (0 and 7 are both Sunday). Numeric only — no month/day
 * names (the builder UI writes numeric expressions).
 *
 * DOM-OR-DOW (vixie rule): when BOTH day-of-month and day-of-week are
 * restricted, a date matches when EITHER matches; when only one is
 * restricted, that one must match. "Restricted" follows vixie/cronie
 * exactly: a field is UNrestricted when its text BEGINS with `*` — so `*`
 * AND `*` -step forms like `*\/2` are unrestricted (AND semantics), while
 * `1-31` (even though it matches every day) is restricted.
 *
 * All evaluation is UTC at minute precision (seconds/millis zeroed) — the
 * platform stores `next_fire_at` as timestamptz and compares in UTC.
 */

/** Thrown for an expression the grammar rejects. */
export class CronParseError extends Error {
  override readonly name = "CronParseError";
  constructor(
    public readonly expression: string,
    detail: string,
  ) {
    super(`invalid cron expression "${expression}": ${detail}`);
  }
}

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** Normalized: 7 (Sunday) is folded into 0. */
  daysOfWeek: ReadonlySet<number>;
  /**
   * Field text did not BEGIN with `*` (drives the DOM-OR-DOW rule — vixie
   * treats `*` and `*\/n` alike as unrestricted).
   */
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function parseField(
  expression: string,
  field: FieldSpec,
  text: string,
): Set<number> {
  const values = new Set<number>();
  const fail = (detail: string): never => {
    throw new CronParseError(expression, `${field.name} field: ${detail}`);
  };

  for (const item of text.split(",")) {
    if (item.length === 0) fail("empty list item");

    const [rangeText, ...stepParts] = item.split("/");
    if (stepParts.length > 1) fail(`"${item}" has more than one "/"`);
    let step = 1;
    if (stepParts.length === 1) {
      const stepText = stepParts[0]!;
      if (!/^\d+$/.test(stepText)) fail(`step "${stepText}" is not a number`);
      step = Number(stepText);
      if (step < 1) fail("step must be >= 1");
    }

    let low: number;
    let high: number;
    if (rangeText === "*") {
      low = field.min;
      high = field.max;
    } else {
      const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(rangeText ?? "");
      if (!rangeMatch) return fail(`"${item}" is not *, a number, or a range`);
      low = Number(rangeMatch[1]);
      high = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : low;
      if (rangeMatch[2] === undefined && stepParts.length === 1) {
        // "5/2" (a bare value with a step) is a common typo for "5-max/2";
        // reject it rather than guess.
        fail(`"${item}" applies a step to a single value`);
      }
      if (low > high) fail(`range ${low}-${high} is reversed (no wraparound)`);
      if (low < field.min || high > field.max) {
        fail(`value out of range ${field.min}-${field.max}`);
      }
    }

    for (let value = low; value <= high; value += step) values.add(value);
  }

  if (values.size === 0) fail("matches no values");
  return values;
}

/** Parse a 5-field cron expression. Throws {@link CronParseError}. */
export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      expression,
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const [minuteText, hourText, domText, monthText, dowText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const daysOfWeekRaw = parseField(expression, FIELDS[4]!, dowText);
  // Fold Sunday-as-7 into Sunday-as-0 so matching uses Date#getUTCDay directly.
  const daysOfWeek = new Set<number>(
    [...daysOfWeekRaw].map((day) => (day === 7 ? 0 : day)),
  );

  return {
    minutes: parseField(expression, FIELDS[0]!, minuteText),
    hours: parseField(expression, FIELDS[1]!, hourText),
    daysOfMonth: parseField(expression, FIELDS[2]!, domText),
    months: parseField(expression, FIELDS[3]!, monthText),
    daysOfWeek,
    // Vixie/cronie: any dom/dow field BEGINNING with `*` (including `*/n`)
    // is unrestricted — `0 0 */2 * 1` means "odd days AND Mondays", not OR.
    domRestricted: !domText.startsWith("*"),
    dowRestricted: !dowText.startsWith("*"),
  };
}

/** Is `expression` a valid 5-field cron per this evaluator? */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

/** DOM-OR-DOW day matching (see module header). */
function dayMatches(schedule: CronSchedule, dom: number, dow: number): boolean {
  const domHit = schedule.daysOfMonth.has(dom);
  const dowHit = schedule.daysOfWeek.has(dow);
  if (schedule.domRestricted && schedule.dowRestricted) return domHit || dowHit;
  return domHit && dowHit;
}

/**
 * Upper bound on the day walk: > 8 years covers the sparsest satisfiable
 * schedule (Feb 29 falls at most 8 years apart across century boundaries);
 * anything unsatisfied by then (e.g. `0 0 30 2 *`) never fires.
 */
const MAX_SEARCH_DAYS = 3000;

/**
 * The next UTC instant STRICTLY AFTER `after` matching `expression`, at
 * minute precision — or null when the schedule can never fire again (e.g.
 * `0 0 30 2 *`). Throws {@link CronParseError} on a malformed expression.
 * Pure: no clock access; callers pass `after` (the ticker passes "now" so a
 * missed window is skipped, never backfilled).
 */
export function nextFire(
  expression: string | CronSchedule,
  after: Date,
): Date | null {
  const schedule =
    typeof expression === "string" ? parseCronExpression(expression) : expression;

  const hours = [...schedule.hours].sort((a, b) => a - b);
  const minutes = [...schedule.minutes].sort((a, b) => a - b);

  // First candidate minute: `after` truncated to the minute, plus one minute.
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);

  // Walk days; within a matching day, walk the (sorted) hour × minute sets.
  let cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  for (let day = 0; day < MAX_SEARCH_DAYS; day += 1) {
    if (
      schedule.months.has(cursor.getUTCMonth() + 1) &&
      dayMatches(schedule, cursor.getUTCDate(), cursor.getUTCDay())
    ) {
      const isFirstDay = day === 0;
      for (const hour of hours) {
        if (isFirstDay && hour < start.getUTCHours()) continue;
        for (const minute of minutes) {
          if (
            isFirstDay &&
            hour === start.getUTCHours() &&
            minute < start.getUTCMinutes()
          ) {
            continue;
          }
          return new Date(
            Date.UTC(
              cursor.getUTCFullYear(),
              cursor.getUTCMonth(),
              cursor.getUTCDate(),
              hour,
              minute,
            ),
          );
        }
      }
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return null;
}
