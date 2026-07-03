/** Human-readable cron preview (schedule trigger). */
import { expect, test } from "bun:test";

import { describeCron } from "../lib/builder/cron";

test("describes a weekly morning schedule", () => {
  expect(describeCron("0 9 * * 1")).toBe("At 09:00, on Monday");
});

test("describes every-day at a time", () => {
  expect(describeCron("30 8 * * *")).toBe("At 08:30, every day");
});

test("describes multiple weekdays", () => {
  expect(describeCron("0 9 * * 1,3,5")).toBe(
    "At 09:00, on Monday, Wednesday, Friday",
  );
});

test("treats 7 as Sunday", () => {
  expect(describeCron("0 0 * * 7")).toBe("At 00:00, on Sunday");
});

test("describes every-N-minutes", () => {
  expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
});

test("describes day-of-month schedules", () => {
  expect(describeCron("0 0 1 * *")).toBe("At 00:00, on day 1 of the month");
});

test("returns null for a non-5-field expression", () => {
  expect(describeCron("0 9 * *")).toBeNull();
  expect(describeCron("")).toBeNull();
});

test("returns null for out-of-range fields", () => {
  expect(describeCron("99 9 * * 1")).toBeNull();
});
