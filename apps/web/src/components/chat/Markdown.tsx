/**
 * Streaming markdown renderer for agent replies and copilot messages.
 *
 * Streamdown handles parsing, GFM, Shiki highlighting and incomplete-markdown
 * "remend" while a reply streams. Its default styling reaches the E1 system
 * through the shadcn→ink token bridge in index.css; only the four keys below
 * are overridden, so new markdown elements stay styled without new code.
 *
 * DO NOT override `code` or `pre`. `code` is streamdown's block dispatcher
 * (language detection, the mermaid dispatch, the Shiki CodeBlock) and `pre`
 * stamps the `data-block` marker that drives it — overriding either collapses
 * every fenced block into inline code. Inline code has its own key.
 */
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import type {
  Components,
  ControlsConfig,
  ExtraProps,
  LinkSafetyConfig,
  PluginConfig,
  ThemeInput,
} from "streamdown";
import { code } from "@streamdown/code";

import { cn } from "../../lib/cn";

/**
 * Streamdown's outer memo compares `shikiTheme`, `plugins` and `linkSafety`
 * BY IDENTITY, and its inner Block memo compares each `components` value the
 * same way. Inline literals would defeat per-block memoization and re-highlight
 * every code block on every streamed token — these MUST stay at module scope.
 */
const SHIKI_THEMES: [ThemeInput, ThemeInput] = ["min-light", "min-dark"];

const PLUGINS: PluginConfig = { code };

/** Copy only — download, fullscreen and panZoom are not E1-styled surfaces. */
const CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: { copy: true, download: false, fullscreen: false, panZoom: false },
};

/**
 * Explicitly off. The custom `a` below already replaces the default anchor
 * (which renders external links as a confirm-modal <button>), so link safety
 * is disabled in practice — saying so here keeps behavior from silently
 * flipping if that override is ever removed.
 */
const LINK_SAFETY: LinkSafetyConfig = { enabled: false };

/** remend's placeholder for a link whose href has not finished streaming. */
const INCOMPLETE_LINK = "streamdown:incomplete-link";

/**
 * `ExtraProps` is not decoration: `Components` carries an index signature
 * requiring every value to accept `Record<string, unknown> & ExtraProps`, so a
 * bare `ComponentProps<"code">` fails to typecheck. react-markdown also passes
 * the hast `node` at runtime — destructure it away rather than spreading it
 * onto the element, where it serializes as `node="[object Object]"`.
 */
function InlineCode({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"code"> & ExtraProps) {
  return (
    <code {...props} className={cn("mono-chip", className)}>
      {children}
    </code>
  );
}

function MarkdownLink({
  href,
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"a"> & ExtraProps) {
  // A half-streamed link, or one the sanitizer stripped, renders as its text
  // rather than a dead anchor.
  if (href === undefined || href === INCOMPLETE_LINK) {
    return <span className={className}>{children}</span>;
  }
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        "rounded-sm font-medium text-ink underline decoration-black/25 underline-offset-2 transition-colors duration-150 hover:decoration-black/60",
        className,
      )}
    >
      {children}
    </a>
  );
}

const HEADING_SIZES: Record<number, string> = {
  1: "text-[17px]",
  2: "text-[15px]",
  3: "text-sm",
  4: "text-[13px]",
  5: "text-[13px]",
  6: "text-[13px]",
};

/**
 * Agent replies are untrusted content inside a page that owns its own heading
 * outline, so markdown headings render as ARIA headings offset two levels
 * down — never real <h1>–<h6>, which would hijack landmark navigation.
 * Called at module scope, so each component identity is stable.
 */
function makeHeading(level: number) {
  const ariaLevel = Math.min(level + 2, 6);
  return function MarkdownHeading({
    children,
    className,
  }: ComponentProps<"h1"> & ExtraProps) {
    return (
      <p
        role="heading"
        aria-level={ariaLevel}
        className={cn(
          "mb-1 mt-3 font-semibold tracking-tight text-ink",
          HEADING_SIZES[level],
          className,
        )}
      >
        {children}
      </p>
    );
  };
}

const COMPONENTS: Components = {
  inlineCode: InlineCode,
  a: MarkdownLink,
  h1: makeHeading(1),
  h2: makeHeading(2),
  h3: makeHeading(3),
  h4: makeHeading(4),
  h5: makeHeading(5),
  h6: makeHeading(6),
};

export interface MarkdownProps {
  text: string;
  className?: string;
  /** Drives the streaming caret and suppresses copy controls mid-stream. */
  streaming?: boolean;
}

export function Markdown({ text, className, streaming }: MarkdownProps) {
  return (
    <Streamdown
      mode="streaming"
      isAnimating={streaming ?? false}
      caret="block"
      plugins={PLUGINS}
      shikiTheme={SHIKI_THEMES}
      controls={CONTROLS}
      linkSafety={LINK_SAFETY}
      lineNumbers={false}
      components={COMPONENTS}
      className={cn(
        "space-y-2 text-sm text-ink [overflow-wrap:anywhere]",
        className,
      )}
    >
      {text}
    </Streamdown>
  );
}
