/**
 * Cron evaluator unit tests — the grammar (star, star-slash-step, lists,
 * ranges, range steps), the DOM-OR-DOW rule, UTC/rollover behavior, and
 * never-fires detection. Pure: no clock, no DB.
 */
import { describe, expect, test } from "bun:test";

import {
  CronParseError,
  isValidCronExpression,
  nextFire,
  parseCronExpression,
} from "./cron";

const at = (iso: string): Date => new Date(iso);
const next = (expr: string, after: string): string | null =>
  nextFire(expr, at(after))?.toISOString() ?? null;

describe("parseCronExpression", () => {
  test("* expands to the full field range", () => {
    const s = parseCronExpression("* * * * *");
    expect(s.minutes.size).toBe(60);
    expect(s.hours.size).toBe(24);
    expect(s.daysOfMonth.size).toBe(31);
    expect(s.months.size).toBe(12);
    expect(s.daysOfWeek.size).toBe(7);
    expect(s.domRestricted).toBe(false);
    expect(s.dowRestricted).toBe(false);
  });

  test("*/n steps from the field minimum", () => {
    expect([...parseCronExpression("*/15 * * * *").minutes].sort((a, b) => a - b)).toEqual([
      0, 15, 30, 45,
    ]);
    // day-of-month starts at 1: */10 → 1, 11, 21, 31.
    expect(
      [...parseCronExpression("0 0 */10 * *").daysOfMonth].sort((a, b) => a - b),
    ).toEqual([1, 11, 21, 31]);
  });

  test("lists, ranges, and range steps", () => {
    expect([...parseCronExpression("1,5,9 * * * *").minutes].sort((a, b) => a - b)).toEqual([
      1, 5, 9,
    ]);
    expect([...parseCronExpression("* 9-12 * * *").hours].sort((a, b) => a - b)).toEqual([
      9, 10, 11, 12,
    ]);
    expect(
      [...parseCronExpression("10-30/10 * * * *").minutes].sort((a, b) => a - b),
    ).toEqual([10, 20, 30]);
    expect(
      [...parseCronExpression("0 0 * * 1-5,0").daysOfWeek].sort((a, b) => a - b),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("day-of-week 7 normalizes to Sunday (0)", () => {
    const s = parseCronExpression("0 0 * * 7");
    expect([...s.daysOfWeek]).toEqual([0]);
  });

  test.each([
    ["* * * *", "wrong field count"],
    ["* * * * * *", "six fields"],
    ["60 * * * *", "minute out of range"],
    ["* 24 * * *", "hour out of range"],
    ["* * 0 * *", "day-of-month below range"],
    ["* * 32 * *", "day-of-month above range"],
    ["* * * 13 *", "month out of range"],
    ["* * * * 8", "day-of-week above range"],
    ["30-10 * * * *", "reversed range"],
    ["*/0 * * * *", "zero step"],
    ["5/2 * * * *", "step on a single value"],
    ["a * * * *", "non-numeric"],
    ["1,,2 * * * *", "empty list item"],
    ["*/x * * * *", "non-numeric step"],
    ["1-2-3 * * * *", "malformed range"],
    ["", "empty expression"],
  ])("rejects %s (%s)", (expr) => {
    expect(() => parseCronExpression(expr)).toThrow(CronParseError);
    expect(isValidCronExpression(expr)).toBe(false);
  });

  test("isValidCronExpression accepts valid grammar", () => {
    expect(isValidCronExpression("*/5 9-17 * * 1-5")).toBe(true);
  });
});

describe("nextFire", () => {
  test("every minute: fires at the NEXT minute boundary, strictly after", () => {
    expect(next("* * * * *", "2026-07-10T12:00:00.000Z")).toBe(
      "2026-07-10T12:01:00.000Z",
    );
    // Mid-minute input truncates then advances — never fires "now".
    expect(next("* * * * *", "2026-07-10T12:00:59.999Z")).toBe(
      "2026-07-10T12:01:00.000Z",
    );
  });

  test("an exact-match `after` is skipped (strictly after)", () => {
    expect(next("30 12 * * *", "2026-07-10T12:30:00.000Z")).toBe(
      "2026-07-11T12:30:00.000Z",
    );
  });

  test("*/15: next quarter hour", () => {
    expect(next("*/15 * * * *", "2026-07-10T12:16:00.000Z")).toBe(
      "2026-07-10T12:30:00.000Z",
    );
  });

  test("daily at 09:00 UTC rolls to tomorrow after the window", () => {
    expect(next("0 9 * * *", "2026-07-10T09:00:00.000Z")).toBe(
      "2026-07-11T09:00:00.000Z",
    );
    expect(next("0 9 * * *", "2026-07-10T08:59:00.000Z")).toBe(
      "2026-07-10T09:00:00.000Z",
    );
  });

  test("weekday business hours: skips the weekend", () => {
    // 2026-07-10 is a Friday; after 17:00 the next 09:00-17:00 weekday slot
    // is Monday 09:00.
    expect(next("0 9-17 * * 1-5", "2026-07-10T17:00:00.000Z")).toBe(
      "2026-07-13T09:00:00.000Z",
    );
  });

  test("month + year rollover", () => {
    expect(next("0 0 1 * *", "2026-12-31T23:59:00.000Z")).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    // Only fires in March: from July, next is March 1 next year.
    expect(next("30 6 1 3 *", "2026-07-10T00:00:00.000Z")).toBe(
      "2027-03-01T06:30:00.000Z",
    );
  });

  test("day-of-month clamps to real month lengths (no Feb 31)", () => {
    expect(next("0 0 31 * *", "2026-02-01T00:00:00.000Z")).toBe(
      "2026-03-31T00:00:00.000Z",
    );
  });

  test("leap day: finds the next Feb 29", () => {
    expect(next("0 0 29 2 *", "2026-07-10T00:00:00.000Z")).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  test("never-satisfiable schedules return null", () => {
    expect(next("0 0 30 2 *", "2026-07-10T00:00:00.000Z")).toBeNull();
  });

  test("DOM-OR-DOW: both restricted → fires on EITHER", () => {
    // "the 13th or any Friday". From Mon 2026-07-06: Friday the 10th comes
    // before Monday the 13th.
    expect(next("0 0 13 * 5", "2026-07-06T00:00:00.000Z")).toBe(
      "2026-07-10T00:00:00.000Z",
    );
    // From Sat the 11th, the 13th (a Monday) wins over next Friday the 17th.
    expect(next("0 0 13 * 5", "2026-07-11T00:00:00.000Z")).toBe(
      "2026-07-13T00:00:00.000Z",
    );
  });

  test("only DOW restricted → DOW must match (no OR)", () => {
    // Sundays only, via both 0 and 7 spellings.
    expect(next("0 0 * * 0", "2026-07-10T00:00:00.000Z")).toBe(
      "2026-07-12T00:00:00.000Z",
    );
    expect(next("0 0 * * 7", "2026-07-10T00:00:00.000Z")).toBe(
      "2026-07-12T00:00:00.000Z",
    );
  });

  test("only DOM restricted → DOM must match (no OR)", () => {
    expect(next("0 0 13 * *", "2026-07-10T00:00:00.000Z")).toBe(
      "2026-07-13T00:00:00.000Z",
    );
  });

  test("a dom/dow field beginning with * (e.g. */2) is UNrestricted — vixie AND semantics", () => {
    // "0 0 */2 * 1": midnight on odd days, Mondays only (vixie/cronie).
    // From Fri 2026-07-10: Mon the 13th is odd → fires; treating */2 as
    // restricted would wrongly fire on Sat the 11th (odd day OR Monday).
    const s = parseCronExpression("0 0 */2 * 1");
    expect(s.domRestricted).toBe(false);
    expect(s.dowRestricted).toBe(true);
    expect(next("0 0 */2 * 1", "2026-07-10T00:00:00.000Z")).toBe(
      "2026-07-13T00:00:00.000Z",
    );
    // Symmetric: "*/2" in DOW is unrestricted too — "0 0 13 * */2" is "the
    // 13th, on any even weekday" under AND, not "13th OR even weekdays".
    const t = parseCronExpression("0 0 13 * */2");
    expect(t.domRestricted).toBe(true);
    expect(t.dowRestricted).toBe(false);
    // From 2026-07-10: the next 13th falling on an even weekday (Sun/Tue/
    // Thu/Sat) — Mon 2026-07-13 is skipped; Thu 2026-08-13 matches.
    expect(next("0 0 13 * */2", "2026-07-10T00:00:00.000Z")).toBe(
      "2026-08-13T00:00:00.000Z",
    );
  });

  test("accepts a pre-parsed schedule", () => {
    const schedule = parseCronExpression("*/30 * * * *");
    expect(nextFire(schedule, at("2026-07-10T12:01:00.000Z"))?.toISOString()).toBe(
      "2026-07-10T12:30:00.000Z",
    );
  });

  test("throws CronParseError for malformed input", () => {
    expect(() => nextFire("bogus", at("2026-07-10T00:00:00.000Z"))).toThrow(
      CronParseError,
    );
  });
});
