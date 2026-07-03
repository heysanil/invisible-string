import { describe, expect, test } from "bun:test";

import { worldNameForHash, worldUrlFor } from "./world";

describe("worldNameForHash", () => {
  test("ws_v_ + first 12 hash chars (a stable pg identifier)", () => {
    expect(worldNameForHash("abcdef0123456789deadbeef")).toBe("ws_v_abcdef012345");
  });

  test("normalizes case and strips non-alphanumerics", () => {
    expect(worldNameForHash("ABCDEF-01234_56789")).toBe("ws_v_abcdef012345");
  });

  test("rejects hashes too short to identify a version", () => {
    expect(() => worldNameForHash("abc")).toThrow(/too short/);
  });
});

describe("worldUrlFor", () => {
  test("swaps only the database path on the world server URL", () => {
    expect(
      worldUrlFor("postgres://dev:dev@localhost:5432/world", "ws_v_abcdef012345"),
    ).toBe("postgres://dev:dev@localhost:5432/ws_v_abcdef012345");
  });

  test("preserves query parameters (e.g. sslmode)", () => {
    expect(
      worldUrlFor("postgres://u:p@db.example.com:5432/world?sslmode=require", "ws_v_000000000000"),
    ).toBe("postgres://u:p@db.example.com:5432/ws_v_000000000000?sslmode=require");
  });
});
