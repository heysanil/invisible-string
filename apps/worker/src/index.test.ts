import { expect, test } from "bun:test";

import { WORKER_NAME, workerPlaceholder } from "./index";

test("worker placeholder returns its name", () => {
  expect(workerPlaceholder()).toBe(WORKER_NAME);
});
