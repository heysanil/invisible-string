/**
 * Markdown rendering (happy-dom): the GFM surface the old parser lacked,
 * plus the E1 treatments and a11y behaviors that must survive the swap.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import { Markdown } from "../components/chat/Markdown";

ensureDomForThisFile();
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("renders a GFM table — the old parser dropped these entirely", async () => {
  const view = render(<Markdown text={"| a | b |\n| - | - |\n| 1 | 2 |"} />);
  const table = await view.findByRole("table");
  expect(table).not.toBeNull();
  expect(table.textContent).toContain("1");
});

test("renders nested lists", async () => {
  const view = render(<Markdown text={"- outer\n  - inner"} />);
  await view.findByText("inner");
  expect(view.container.querySelectorAll("ul").length).toBe(2);
});

test("renders task lists and strikethrough", async () => {
  const view = render(<Markdown text={"- [x] done\n\n~~gone~~"} />);
  await view.findByText("done");
  expect(view.container.querySelector("input[type=checkbox]")).not.toBeNull();
  expect(view.container.querySelector("del")).not.toBeNull();
});

test("inline code keeps the E1 mono-chip treatment", async () => {
  const view = render(<Markdown text="use `bun test` here" />);
  const code = await view.findByText("bun test");
  expect(code.tagName).toBe("CODE");
  expect(code.className).toContain("mono-chip");
});

/**
 * Shiki splits highlighted source across one span per token, so `findByText`
 * on the code itself only works while the highlighter is still cold — it turns
 * order-dependent the moment another test in the file warms it. Read the block's
 * textContent instead, which holds in both states.
 */
async function findCodeText(container: HTMLElement): Promise<string> {
  return await waitFor(() => {
    const text = container.querySelector("pre code")?.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    return text;
  });
}

test("a fenced block renders as a block, not inline code", async () => {
  const view = render(<Markdown text={"```ts\nconst x = 1;\n```"} />);
  expect(await findCodeText(view.container)).toContain("const x = 1;");
  // Guards the components.code / components.pre footgun: overriding either
  // collapses fenced blocks into inline code.
  expect(view.container.querySelector("pre")).not.toBeNull();
  expect(view.container.querySelector("pre code")?.className ?? "").not.toContain(
    "mono-chip",
  );
});

test(
  "code blocks highlight with the configured min themes, not shiki's default",
  async () => {
    // Streamdown resolves the theme as `plugins.code.getThemes() ?? shikiTheme`
    // — the PROP is only a fallback, so a plugin built without themes silently
    // wins and renders github-light's full-saturation palette. That is dead
    // config plus an E1 rule-5 violation (color only as meaning), and it is
    // invisible without an assertion on the emitted colors.
    //
    // Assert the theme by the block's own bg/fg, NOT by which token got which
    // scope. `@streamdown/code` builds its shiki engine with
    // `createJavaScriptRegexEngine({ forgiving: true })`, which silently SKIPS
    // any pattern whose `exec` throws on a given call — and dual-theme
    // highlighting tokenizes once PER THEME (`codeToTokensWithThemes` maps
    // `codeToTokensBase` over both, then re-aligns the boundaries). So one
    // pass can degrade while the other stays sharp: seen in a loaded CI lane
    // as `const` still min-light red while everything after it flattened to
    // min-light's default foreground, carrying min-DARK's per-scope colors on
    // the same spans. Per-token colors are therefore not a stable property of
    // "the min themes are configured"; `result.bg`/`result.fg` are read
    // straight off the loaded theme objects and are immune to tokenization.
    const view = render(<Markdown text={"```ts\nconst x = 1;\n```"} />);
    // Shiki highlights asynchronously; until it lands streamdown renders the
    // placeholder result, whose `--sdm-bg` is the literal `transparent`.
    const pre = await waitFor(
      () => {
        const el = view.container.querySelector("pre");
        expect(el?.style.getPropertyValue("--sdm-bg") ?? "").toMatch(/^#/);
        return el as HTMLElement;
      },
      { timeout: 10_000, interval: 50 },
    );
    // Both halves of the pair, exactly — shiki packs the dark theme's value
    // into the same declaration as the light one, so one assertion pins both.
    // github-light/github-dark would read `#fff;--shiki-dark-bg:#24292e` and
    // `#24292e;--shiki-dark:#e1e4e8`.
    expect(pre.style.getPropertyValue("--sdm-bg")).toBe(
      "#ffffff;--shiki-dark-bg:#1f1f1f",
    );
    expect(pre.style.getPropertyValue("--sdm-fg")).toBe(
      "#24292eff;--shiki-dark:#b392f0",
    );
    // Belt and braces on the token palette: github-light's keyword red is the
    // one color the stock plugin emits that no min pass can produce, degraded
    // or not.
    expect(view.container.innerHTML).not.toContain("#D73A49");
  },
  15_000,
);

test("agent headings never enter the document outline as real headings", async () => {
  const view = render(<Markdown text={"# Title\n\n## Sub"} />);
  const h1 = await view.findByText("Title");
  // Agent replies are untrusted content inside a page with its own outline;
  // a real <h1> would hijack screen-reader landmark navigation.
  expect(h1.tagName).toBe("P");
  expect(h1.getAttribute("role")).toBe("heading");
  expect(h1.getAttribute("aria-level")).toBe("3");
  expect((await view.findByText("Sub")).getAttribute("aria-level")).toBe("4");
});

test("aria-level is capped at 6 for deep headings", async () => {
  const view = render(<Markdown text="###### Deep" />);
  // n+2 would be 8 — legal ARIA but nonsense.
  expect((await view.findByText("Deep")).getAttribute("aria-level")).toBe("6");
});

test("links open safely in a new tab", async () => {
  const view = render(<Markdown text="[home](https://example.com)" />);
  const link = await view.findByText("home");
  expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  expect(link.getAttribute("target")).toBe("_blank");
});

test("javascript: links are stripped", async () => {
  const view = render(<Markdown text="[bad](javascript:alert(1))" />);
  // rehype-harden (streamdown's sanitizer) uses its default "indicator"
  // block policy: the anchor is REPLACED by a span carrying the link text
  // plus a " [blocked]" suffix, so the accessible name is "bad [blocked]"
  // and no anchor survives at all. Match loosely on the text, and assert the
  // security property directly.
  await view.findByText(/bad/);
  expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(view.container.querySelector("a")).toBeNull();
});

test("a mermaid fence renders without crashing and keeps its source", async () => {
  // The plugin loads dynamically, and happy-dom has no real layout — the
  // diagram itself never renders here, so assert only that the block is
  // handled and the source survives. Diagram rendering is an e2e concern.
  const view = render(
    <Markdown text={"```mermaid\ngraph TD;\n  A-->B;\n```"} />,
  );
  expect(await view.findByText(/graph TD/)).not.toBeNull();
});

test("markdown with no mermaid fence renders normally", async () => {
  const view = render(<Markdown text={"```ts\nconst x = 1;\n```"} />);
  expect(await findCodeText(view.container)).toContain("const x = 1;");
});

test("the caret shows only while streaming", async () => {
  // NOTE: the fixture must NOT end mid-fence — streamdown suppresses the
  // caret while the last block is an incomplete code fence.
  //
  // The `content-[var(--streamdown-caret)]` utility sits on the wrapper in
  // BOTH states — only the inline custom property that feeds it is toggled,
  // so an innerHTML substring check on the token name is vacuously true.
  // Assert on the property itself.
  const caretOf = (container: HTMLElement) =>
    (container.firstElementChild as HTMLElement).style.getPropertyValue(
      "--streamdown-caret",
    );

  const streamed = render(<Markdown text="partial reply" streaming />);
  await streamed.findByText("partial reply");
  expect(caretOf(streamed.container)).not.toBe("");
  cleanup();

  const settled = render(<Markdown text="partial reply" />);
  await settled.findByText("partial reply");
  expect(caretOf(settled.container)).toBe("");
});
