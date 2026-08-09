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
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import type {
  Components,
  ControlsConfig,
  DiagramPlugin,
  ExtraProps,
  LinkSafetyConfig,
  MermaidErrorComponentProps,
  MermaidOptions,
  PluginConfig,
  ThemeInput,
} from "streamdown";
import { createCodePlugin } from "@streamdown/code";

import { cn } from "../../lib/cn";

/**
 * Streamdown's outer memo compares `shikiTheme`, `plugins` and `linkSafety`
 * BY IDENTITY, and its inner Block memo compares each `components` value the
 * same way. Inline literals would defeat per-block memoization and re-highlight
 * every code block on every streamed token — these MUST stay at module scope.
 */
const SHIKI_THEMES: [ThemeInput, ThemeInput] = ["min-light", "min-dark"];

/**
 * The themes MUST be built into the plugin. Streamdown resolves them as
 * `plugins.code.getThemes() ?? shikiTheme`, so the prop is only a fallback for
 * when no code plugin is configured — the stock `code` export carries shiki's
 * github-light/github-dark defaults and silently wins, painting agent replies
 * in a full-saturation palette E1 does not sanction. The prop below stays as
 * the documented fallback. Guard: `__tests__/markdown-render.test.tsx`.
 */
const CODE_PLUGIN = createCodePlugin({ themes: SHIKI_THEMES });

const CODE_ONLY_PLUGINS: PluginConfig = { code: CODE_PLUGIN };

/** A fence opening a mermaid block, at the start of any line. */
const MERMAID_FENCE = /^```mermaid\b/m;

/**
 * @streamdown/mermaid imports the mermaid library STATICALLY, so importing it
 * at module scope would put multiple megabytes in the SPA entry chunk. Load it
 * on demand instead. Module-level promise = one fetch per session, shared by
 * every Markdown instance.
 */
let mermaidPluginPromise: Promise<DiagramPlugin> | null = null;
function loadMermaidPlugin(): Promise<DiagramPlugin> {
  mermaidPluginPromise ??= import("@streamdown/mermaid").then((m) => m.mermaid);
  return mermaidPluginPromise;
}

/**
 * Streamdown's Mermaid component reads the plugin from context and lists it in
 * its effect deps, so a diagram that mounted before the plugin arrived
 * re-renders out of its "plugin unavailable" state on its own.
 */
function useMarkdownPlugins(text: string): PluginConfig {
  const needsMermaid = MERMAID_FENCE.test(text);
  const [mermaidPlugin, setMermaidPlugin] = useState<DiagramPlugin | null>(null);

  useEffect(() => {
    if (!needsMermaid || mermaidPlugin !== null) return;
    let alive = true;
    void loadMermaidPlugin().then((plugin) => {
      if (alive) setMermaidPlugin(plugin);
    });
    return () => {
      alive = false;
    };
  }, [needsMermaid, mermaidPlugin]);

  return useMemo(
    () =>
      mermaidPlugin === null
        ? CODE_ONLY_PLUGINS
        : { code: CODE_PLUGIN, mermaid: mermaidPlugin },
    [mermaidPlugin],
  );
}

/**
 * Streamdown's default mermaid error card is hardcoded `bg-red-50 text-red-700`
 * — raw palette colors, which E1 forbids (color only as meaning; `--err` is the
 * sanctioned error token). Mirrors the error banner in `RunMessage.tsx`.
 */
function MermaidError({ error, retry }: MermaidErrorComponentProps) {
  return (
    <div
      role="alert"
      className="my-1.5 flex items-start gap-2 rounded-card border border-err/35 bg-err/[0.05] px-3 py-2 text-[13px] text-ink"
    >
      <span className="min-w-0">Diagram failed to render: {error}</span>
      <button
        type="button"
        onClick={retry}
        className="lift shrink-0 rounded-capsule px-2 py-0.5 text-[12px] font-medium text-ink-3 hover:bg-black/[0.05] hover:text-ink"
      >
        Retry
      </button>
    </div>
  );
}

const MERMAID_OPTIONS: MermaidOptions = { errorComponent: MermaidError };

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
  const plugins = useMarkdownPlugins(text);
  return (
    <Streamdown
      mode="streaming"
      isAnimating={streaming ?? false}
      caret="block"
      plugins={plugins}
      shikiTheme={SHIKI_THEMES}
      mermaid={MERMAID_OPTIONS}
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
