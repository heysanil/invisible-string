/**
 * Guard: Streamdown's Tailwind wiring. Both halves fail SILENTLY in the
 * browser — a missing @source means Tailwind never scans streamdown's dist
 * (unstyled prose, and the streaming caret simply never appears), and a
 * missing bridge token compiles to an undefined custom property that CSS
 * discards at computed-value time. Neither throws, so only a test catches it.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(HERE, "../index.css");
const css = await Bun.file(CSS_PATH).text();

/** Every shadcn token streamdown's dist actually uses. */
const BRIDGE_TOKENS = [
  "--color-foreground",
  "--color-muted-foreground",
  "--color-background",
  "--color-muted",
  "--color-border",
  "--color-primary",
  "--color-primary-foreground",
];

test("index.css @sources streamdown's dist, and the path resolves", () => {
  const match = css.match(/@source\s+"([^"]*streamdown\/dist[^"]*)"/);
  expect(match).not.toBeNull();

  const globbed = match![1]!;
  const dir = resolve(dirname(CSS_PATH), globbed.replace(/\/\*\.js$/, ""));
  // A stale relative depth is the whole failure mode this guards.
  expect(existsSync(dir)).toBe(true);
});

test("every shadcn token streamdown uses is bridged to an E1 token", () => {
  for (const token of BRIDGE_TOKENS) {
    expect(css).toContain(token);
  }
});
