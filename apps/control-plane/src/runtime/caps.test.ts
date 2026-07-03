import { describe, expect, test } from "bun:test";

import { ACTIVE_RUN_STATUSES, wouldExceedRunCap } from "./caps";

describe("run cap logic", () => {
  test("active statuses are queued/running/waiting (parked runs hold a slot)", () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(["queued", "running", "waiting"]);
  });

  test("under the cap: starting one more is allowed", () => {
    expect(wouldExceedRunCap(0, 5)).toBeFalse();
    expect(wouldExceedRunCap(4, 5)).toBeFalse();
  });

  test("at the cap: starting one more is rejected", () => {
    expect(wouldExceedRunCap(5, 5)).toBeTrue();
    expect(wouldExceedRunCap(6, 5)).toBeTrue();
  });

  test("cap of 1 permits exactly one active run", () => {
    expect(wouldExceedRunCap(0, 1)).toBeFalse();
    expect(wouldExceedRunCap(1, 1)).toBeTrue();
  });
});
