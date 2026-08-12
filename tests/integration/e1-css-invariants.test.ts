/**
 * E1 CSS invariants that fail SILENTLY in the browser.
 *
 * Two pieces of the design system are load-bearing in a way their own text
 * does not advertise, and neither has a runtime symptom anything downstream
 * could catch — undo one and the product just looks subtly wrong forever.
 *
 * 1. THE STREAMING CARET MUST CONTRIBUTE ZERO INLINE ADVANCE. There are two
 *    copies of it: streamdown's `::after` glyph in `apps/web/src/index.css`
 *    and `.stream-caret` in the tokens (apps/site). Both are ordinary
 *    wrappable boxes sitting at the end of the last line, so Chrome breaks
 *    before them and the caret blinks alone on a line of its own — measured
 *    over a 150–400px width sweep against real Chrome: 40 of 301 widths for
 *    the apps/web caret, 13 of 301 for `.stream-caret`. Cancelling the advance
 *    (a zero-width box, or a negative end margin that exactly undoes width +
 *    gap) drops all of them to zero, because a box that never lengthens a line
 *    never forces the break to be taken. `white-space: nowrap` is NOT a
 *    substitute: on the glyph it still orphans ~6% of unbreakable tails (a
 *    long URL under `[overflow-wrap:anywhere]`), and on `.stream-caret` it
 *    does nothing at all — the break opportunity before an atomic inline
 *    belongs to the nearest common ancestor, not to the pseudo-element.
 *
 * 2. `.lift:hover` SCALES, IT DOES NOT RISE (2026-08-11 spec, D10) — one rule,
 *    87 call sites — and the unlayered `prefers-reduced-motion: reduce` block
 *    must drop the transform outright. The duration clamp beside it only makes
 *    the change INSTANT; the element would still resize under the cursor.
 *
 * Pure filesystem parsing — no browser, no DB, never gated.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const TOKENS = join(ROOT, "packages", "design-tokens", "tokens.css");
const WEB_CSS = join(ROOT, "apps", "web", "src", "index.css");

/**
 * Comments are stripped first, and every assertion below reads the stripped
 * text: both of these files EXPLAIN their invariants in prose right next to
 * the declarations that carry them, so a naive substring search matches the
 * comment and passes on a file whose rules say the opposite.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = strip(readFileSync(TOKENS, "utf8"));
const web = strip(readFileSync(WEB_CSS, "utf8"));

/** The body of the first rule whose selector matches, braces excluded. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} is missing entirely`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** One declaration's value, up to its semicolon (nested parens survive). */
function declaration(body: string, property: string): string | null {
  const at = body.indexOf(`${property}:`);
  if (at < 0) return null;
  return body.slice(at + property.length + 1, body.indexOf(";", at)).trim();
}

describe("tokens.css · .lift hover affordance (spec 2026-08-11 D10)", () => {
  test("hover swells, and never rises again", () => {
    const hover = ruleBody(tokens, ".lift:hover");
    expect(hover).toContain("scale(1.01)");
    expect(
      hover,
      "D10 retired the hover rise: .lift:hover must scale, not translate.",
    ).not.toContain("translate");
  });

  test("active returns to rest", () => {
    expect(ruleBody(tokens, ".lift:active")).toContain("scale(1)");
  });

  test("reduced motion removes the transform, not just its duration", () => {
    const marker = tokens.indexOf("Resilience fallbacks");
    const reduce = tokens.indexOf("@media (prefers-reduced-motion: reduce)");
    // Unlayered is what lets it outrank the @layer components rule above.
    expect(
      reduce,
      "the reduced-motion block must stay in the unlayered resilience tail",
    ).toBeGreaterThan(marker);

    const block = tokens.slice(reduce);
    expect(block).toContain("transition-duration: 0.01ms !important");
    // A duration clamp alone leaves the scale in place, applied instantly.
    expect(
      declaration(ruleBody(block, ".lift:hover"), "transform"),
      "reduced motion must also zero .lift's hover transform",
    ).toBe("none");
  });
});

describe("tokens.css · .stream-caret cannot be orphaned (apps/site)", () => {
  const caret = ruleBody(tokens, ".stream-caret::after");

  test("the caret is an inline-block sized from its own tokens", () => {
    expect(caret).toContain("display: inline-block");
    expect(caret).toContain("width: var(--caret-w)");
    expect(caret).toContain("margin-left: var(--caret-gap)");
  });

  test("its end margin cancels width + gap exactly", () => {
    // Written against the two custom properties rather than a literal, so the
    // cancellation cannot drift out of sync with a retuned caret.
    expect(
      declaration(caret, "margin-right"),
      "the negative end margin is the whole fix — without it the caret " +
        "lengthens the line and Chrome breaks before it at a full line.",
    ).toBe("calc(-1 * (var(--caret-w) + var(--caret-gap)))");
  });

  test("it still blinks", () => {
    expect(caret).toContain("animation: caret-blink");
  });
});

describe("apps/web index.css · streamdown's caret cannot be orphaned", () => {
  const SELECTOR = '[style*="--streamdown-caret"] > *:last-child::after';
  const caret = ruleBody(web, SELECTOR);

  test("the caret takes no inline width", () => {
    expect(caret).toContain("display: inline-block");
    expect(caret).toContain("width: 0");
  });

  test("the gap that replaces the glyph's leading space is cancelled", () => {
    const left = /margin-left:\s*(-?\d+)px/.exec(caret);
    const right = /margin-right:\s*(-?\d+)px/.exec(caret);
    expect(left, "the caret needs a gap — the leading space is trimmed").not.toBeNull();
    expect(right).not.toBeNull();
    expect(
      Number(left![1]) + Number(right![1]),
      "the two margins must sum to zero, or the caret still lengthens the line",
    ).toBe(0);
  });

  test("the layout fix applies regardless of motion preference", () => {
    const layout = web.indexOf(SELECTOR);
    const motion = web.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(motion, "the blink must stay behind a motion query").toBeGreaterThanOrEqual(0);
    // Inside that query the fix would vanish for reduced-motion users, who
    // would keep the orphaned caret — with no blink to explain it.
    expect(layout).toBeLessThan(motion);
    expect(web.slice(motion)).toContain("animation: caret-blink");
  });
});
