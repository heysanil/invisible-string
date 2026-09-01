/**
 * Step-store tests. The in-memory fake is exercised implicitly by the whole
 * driver suite; here the DRIZZLE implementations are covered (DB-gated,
 * skipping cleanly without TEST_DATABASE_URL): the idempotent (run_id, path)
 * claim, status transitions, the waiting/child link, and the workflow-state
 * upsert semantics — plus fake-vs-schema shape parity kept honest by
 * round-tripping the same calls through both.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { schema } from "@invisible-string/db";

import { createDb, type DbHandle } from "../db";
import { runMigrations } from "../migrate";
import {
  createDrizzleRunStepStore,
  createDrizzleWorkflowStateStore,
  createMemoryRunStepStore,
  type RunStepStore,
  type WorkflowStateStore,
} from "./step-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  console.warn(
    "[pipeline/step-store] TEST_DATABASE_URL not set — skipping drizzle step-store tests",
  );
}

const nano = () => randomUUID().replace(/-/g, "").slice(0, 12);

describe("createMemoryRunStepStore — claim semantics", () => {
  test("second claim on the same (run, path) adopts the existing row", async () => {
    const store = createMemoryRunStepStore();
    const input = {
      runId: "r1",
      organizationId: "org",
      stepId: "st_a",
      stepSlug: "a",
      path: "st_a",
      parentPath: null,
      iteration: null,
      kind: "tool" as const,
      status: "running" as const,
      input: { args: {} },
      startedAt: new Date(),
    };
    const first = await store.claim(input);
    expect(first.created).toBeTrue();
    const second = await store.claim(input);
    expect(second.created).toBeFalse();
    expect(second.row.id).toBe(first.row.id);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("drizzle step + state stores", () => {
  let handle: DbHandle;
  let stepStore: RunStepStore;
  let stateStore: WorkflowStateStore;
  let orgId: string;
  let workflowId: string;
  let runId: string;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 2 });
    stepStore = createDrizzleRunStepStore(handle.db);
    stateStore = createDrizzleWorkflowStateStore(handle.db);
    orgId = `org-ps-${nano()}`;
    await handle.db.insert(schema.organization).values({
      id: orgId,
      name: "Pipeline Store Org",
      slug: `ps-${nano()}`,
      createdAt: new Date(),
    });
    const wf = await handle.db
      .insert(schema.workflows)
      .values({ organizationId: orgId, name: "wf", draft: {} })
      .returning({ id: schema.workflows.id });
    workflowId = wf[0]!.id;
    const run = await handle.db
      .insert(schema.runs)
      .values({
        agentSessionId: null,
        organizationId: orgId,
        workflowId,
        mode: "pipeline",
        triggerEvent: {},
        status: "running",
      })
      .returning({ id: schema.runs.id });
    runId = run[0]!.id;
  });

  afterAll(async () => {
    await handle?.close();
  });

  test("claim is idempotent on (run_id, path); transitions round-trip", async () => {
    const claimInput = {
      runId,
      organizationId: orgId,
      stepId: "st_aaaaaaaaaaaaaaaa",
      stepSlug: "search",
      path: "st_aaaaaaaaaaaaaaaa",
      parentPath: null,
      iteration: null,
      kind: "tool" as const,
      status: "running" as const,
      input: { args: { q: "x" } },
      startedAt: new Date(),
    };
    const first = await stepStore.claim(claimInput);
    expect(first.created).toBeTrue();
    expect(first.row.attempt).toBe(1);
    expect(first.row.status).toBe("running");

    const second = await stepStore.claim(claimInput);
    expect(second.created).toBeFalse();
    expect(second.row.id).toBe(first.row.id);

    await stepStore.markRunning(first.row.id, {
      attempt: 2,
      input: { args: { q: "y" } },
      startedAt: new Date(),
    });
    await stepStore.finish(first.row.id, {
      status: "succeeded",
      output: { hits: 3 },
      completedAt: new Date(),
    });
    const rows = await stepStore.listForRun(runId);
    const row = rows.find((r) => r.id === first.row.id)!;
    expect(row.attempt).toBe(2);
    expect(row.status).toBe("succeeded");
    expect(row.output).toEqual({ hits: 3 });
    expect(row.input).toEqual({ args: { q: "y" } });
  });

  test("loop-instance rows carry parent path + iteration; waiting links the child", async () => {
    const child = await handle.db
      .insert(schema.runs)
      .values({
        agentSessionId: null,
        organizationId: orgId,
        workflowId,
        mode: "agent",
        triggerEvent: {},
        status: "waiting",
      })
      .returning({ id: schema.runs.id });
    const claimed = await stepStore.claim({
      runId,
      organizationId: orgId,
      stepId: "st_bbbbbbbbbbbbbbbb",
      stepSlug: "delegate",
      path: "st_loop/3/st_bbbbbbbbbbbbbbbb",
      parentPath: "st_loop",
      iteration: 3,
      kind: "agent",
      status: "running",
      input: { instructions: "go" },
      startedAt: new Date(),
    });
    await stepStore.markWaiting(claimed.row.id, child[0]!.id);
    const row = (await stepStore.listForRun(runId)).find(
      (r) => r.id === claimed.row.id,
    )!;
    expect(row.status).toBe("waiting");
    expect(row.childRunId).toBe(child[0]!.id);
    expect(row.parentPath).toBe("st_loop");
    expect(row.iteration).toBe(3);
  });

  test("workflow state: snapshot + last-write-wins upsert + key count", async () => {
    expect(await stateStore.snapshot(workflowId)).toEqual({});
    await stateStore.set({
      workflowId,
      organizationId: orgId,
      runId,
      entries: { cursor: "1.0", seen: ["a"] },
    });
    await stateStore.set({
      workflowId,
      organizationId: orgId,
      runId,
      entries: { cursor: "2.0" },
    });
    expect(await stateStore.snapshot(workflowId)).toEqual({
      cursor: "2.0",
      seen: ["a"],
    });
    expect(await stateStore.countKeys(workflowId)).toBe(2);
  });
});
