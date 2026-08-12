/** Relative-time, recency-bucket and row-title tests for the session list. */
import { expect, test } from "bun:test";

import {
  recencyGroup,
  relativeTime,
  sessionRowTitle,
  titleFromMessage,
} from "../lib/chat/time";

const NOW = new Date("2026-07-03T12:00:00.000Z");

test("relativeTime buckets", () => {
  expect(relativeTime("2026-07-03T11:59:30.000Z", NOW)).toBe("now");
  expect(relativeTime("2026-07-03T11:55:00.000Z", NOW)).toBe("5m");
  expect(relativeTime("2026-07-03T09:00:00.000Z", NOW)).toBe("3h");
  expect(relativeTime("2026-07-01T12:00:00.000Z", NOW)).toBe("2d");
  // >7 days → a short date, not a duration.
  expect(relativeTime("2026-06-01T12:00:00.000Z", NOW)).not.toMatch(/^\d+[a-z]$/);
});

test("recencyGroup buckets", () => {
  expect(recencyGroup("2026-07-03T01:00:00.000Z", NOW)).toBe("Today");
  expect(recencyGroup("2026-07-02T23:00:00.000Z", NOW)).toBe("Yesterday");
  expect(recencyGroup("2026-06-29T10:00:00.000Z", NOW)).toBe("Previous 7 days");
  expect(recencyGroup("2026-05-01T10:00:00.000Z", NOW)).toBe("Earlier");
});

test("titleFromMessage takes the first non-empty line and truncates", () => {
  expect(titleFromMessage("Hello there")).toBe("Hello there");
  expect(titleFromMessage("\n\n  Trim me  \nsecond")).toBe("Trim me");
  expect(titleFromMessage("")).toBe("New conversation");
  expect(titleFromMessage("x".repeat(100)).endsWith("…")).toBe(true);
});

// ── sessionRowTitle (spec D9) ───────────────────────────────────────────────

const AGENT = { agentName: "Executive assistant" };

test("a generated title wins over everything", () => {
  expect(
    sessionRowTitle({ ...AGENT, title: "Launch announcement draft" }, "hi there"),
  ).toBe("Launch announcement draft");
});

test("no title falls back to the first message, truncated", () => {
  expect(sessionRowTitle({ ...AGENT, title: null }, "Draft the launch post")).toBe(
    "Draft the launch post",
  );
  expect(
    sessionRowTitle({ ...AGENT, title: null }, "y".repeat(100)).endsWith("…"),
  ).toBe(true);
});

test("no title and no message falls back to the agent — never 'New conversation'", () => {
  // `titleFromMessage("")` answers "New conversation", which is a worse label
  // than the agent's name; the emptiness guard is what keeps it out.
  expect(sessionRowTitle({ ...AGENT, title: null })).toBe("Executive assistant");
  expect(sessionRowTitle({ ...AGENT, title: null }, "")).toBe("Executive assistant");
  expect(sessionRowTitle({ ...AGENT, title: null }, "   \n ")).toBe(
    "Executive assistant",
  );
});

test("a whitespace-only title is treated as no title", () => {
  expect(sessionRowTitle({ ...AGENT, title: "   " }, "Draft the post")).toBe(
    "Draft the post",
  );
});
