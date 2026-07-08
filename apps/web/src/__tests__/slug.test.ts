import { expect, test } from "bun:test";

import { workspaceSlug } from "../lib/slug";

test("derives a lowercase dashed slug with a random suffix", () => {
  expect(workspaceSlug("Acme Inc")).toMatch(/^acme-inc-[0-9a-f]{8}$/);
});

test("strips accents and symbols", () => {
  expect(workspaceSlug("Café Über & Söhne!")).toMatch(
    /^cafe-uber-sohne-[0-9a-f]{8}$/,
  );
});

test("falls back when the name has no slug-safe characters", () => {
  expect(workspaceSlug("!!!")).toMatch(/^workspace-[0-9a-f]{8}$/);
});

test("two calls with the same name do not collide", () => {
  expect(workspaceSlug("Acme")).not.toBe(workspaceSlug("Acme"));
});

test("caps the derived base at 32 characters", () => {
  const slug = workspaceSlug("a".repeat(80));
  expect(slug).toMatch(/^a{32}-[0-9a-f]{8}$/);
});
