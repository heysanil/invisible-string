import { describe, expect, test } from "bun:test";
import { SQL } from "bun";

import {
  createWorldProvisioner,
  worldDatabaseExists,
  worldNameForHash,
  worldUrlFor,
} from "./world";

describe("worldNameForHash", () => {
  test("ag_v_ + first 12 hash chars (a stable pg identifier)", () => {
    expect(worldNameForHash("abcdef0123456789deadbeef")).toBe("ag_v_abcdef012345");
  });

  test("normalizes case and strips non-alphanumerics", () => {
    expect(worldNameForHash("ABCDEF-01234_56789")).toBe("ag_v_abcdef012345");
  });

  test("rejects hashes too short to identify a version", () => {
    expect(() => worldNameForHash("abc")).toThrow(/too short/);
  });
});

describe("worldUrlFor", () => {
  test("swaps only the database path on the world server URL", () => {
    expect(
      worldUrlFor("postgres://dev:dev@localhost:5432/world", "ag_v_abcdef012345"),
    ).toBe("postgres://dev:dev@localhost:5432/ag_v_abcdef012345");
  });

  test("preserves query parameters (e.g. sslmode)", () => {
    expect(
      worldUrlFor("postgres://u:p@db.example.com:5432/world?sslmode=require", "ag_v_000000000000"),
    ).toBe("postgres://u:p@db.example.com:5432/ag_v_000000000000?sslmode=require");
  });
});

// ── DB-gated: provisioning ownership guard (truncation collisions) ─────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("createWorldProvisioner ownership guard", () => {
  // Two DISTINCT full hashes sharing the same first 12 chars — the
  // truncation collision worldNameForHash cannot distinguish.
  const PREFIX = "c0111der0123";
  const hashA = `${PREFIX}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  const hashB = `${PREFIX}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;

  async function dropWorld(): Promise<void> {
    const admin = new SQL(TEST_DATABASE_URL!, { max: 1 });
    try {
      await admin.unsafe(
        `drop database if exists "${worldNameForHash(hashA)}" with (force)`,
      );
    } finally {
      await admin.close();
    }
  }

  test("second version colliding on the truncated name fails LOUDLY; re-ensure of the owner is idempotent", async () => {
    await dropWorld();
    const setupCalls: string[] = [];
    const provisioner = createWorldProvisioner({
      worldDatabaseUrl: TEST_DATABASE_URL!,
      runSetupDatabase: async (_projectDir, url) => {
        setupCalls.push(url);
      },
    });

    expect(await worldDatabaseExists(TEST_DATABASE_URL!, hashA)).toBeFalse();
    const first = await provisioner.ensure(hashA, "/nonexistent-project");
    expect(first.worldName).toBe(`ag_v_${PREFIX}`);
    expect(await worldDatabaseExists(TEST_DATABASE_URL!, hashA)).toBeTrue();

    // Same version again: fine (idempotent).
    await provisioner.ensure(hashA, "/nonexistent-project");
    expect(setupCalls).toHaveLength(2);

    // DIFFERENT version, same truncated world name: loud failure, no sharing.
    await expect(provisioner.ensure(hashB, "/nonexistent-project")).rejects.toThrow(
      /collision|owned by version/,
    );
    expect(setupCalls).toHaveLength(2);

    await dropWorld();
  }, 30_000);
});
