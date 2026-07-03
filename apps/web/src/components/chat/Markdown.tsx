/**
 * Streaming-friendly markdown renderer for agent replies. Parses via
 * lib/chat/markdown (typed AST, no HTML passthrough) and renders ink-styled
 * prose; code blocks get ui-monospace + a copy button.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import {
  parseMarkdown,
  type MdBlock,
  type MdInline,
} from "../../lib/chat/markdown";
import { cn } from "../../lib/cn";

function renderInline(nodes: MdInline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      case "text":
        return <span key={key}>{node.text}</span>;
      case "code":
        return (
          <code key={key} className="mono-chip">
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={key} className="font-semibold text-ink">
            {renderInline(node.children, key)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case "link":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-sm font-medium text-ink underline decoration-black/25 underline-offset-2 transition-colors duration-150 hover:decoration-black/60"
          >
            {renderInline(node.children, key)}
          </a>
        );
    }
  });
}

function CodeBlock({ lang, text }: { lang: string | null; text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions/insecure context) — quietly skip.
    }
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-card border border-black/[0.07] bg-black/[0.035]">
      <div className="flex h-8 items-center justify-between border-b border-black/[0.05] pl-3 pr-1.5">
        <span className="font-mono text-[11px] text-ink-4">{lang ?? "code"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
          className="lift flex h-6 items-center gap-1 rounded-capsule px-2 text-[11px] font-medium text-ink-3 hover:bg-black/[0.05] hover:text-ink"
        >
          {copied ? (
            <>
              <Check size={12} aria-hidden="true" className="text-ok" />
              Copied
            </>
          ) : (
            <>
              <Copy size={12} aria-hidden="true" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed text-ink">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function renderBlock(block: MdBlock, index: number): ReactNode {
  const key = `b-${index}`;
  switch (block.kind) {
    case "p":
      return (
        <p key={key} className="my-1.5 leading-relaxed">
          {renderInline(block.inline, key)}
        </p>
      );
    case "h": {
      const sizes = { 1: "text-[17px]", 2: "text-[15px]", 3: "text-sm", 4: "text-[13px]" } as const;
      return (
        <p
          key={key}
          role="heading"
          aria-level={block.level + 2}
          className={cn("mb-1 mt-3 font-semibold tracking-tight text-ink", sizes[block.level])}
        >
          {renderInline(block.inline, key)}
        </p>
      );
    }
    case "code":
      return <CodeBlock key={key} lang={block.lang} text={block.text} />;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          className={cn(
            "my-1.5 flex list-outside flex-col gap-1 pl-5 leading-relaxed",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`} className="marker:text-ink-4">
              {renderInline(item, `${key}-${itemIndex}`)}
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote
          key={key}
          className="my-2 border-l-2 border-black/15 pl-3 text-ink-2"
        >
          {renderInline(block.inline, key)}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="my-3 border-black/[0.08]" aria-hidden="true" />;
  }
}

export interface MarkdownProps {
  text: string;
  className?: string;
}

export function Markdown({ text, className }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={cn("text-sm text-ink [overflow-wrap:anywhere]", className)}>
      {blocks.map(renderBlock)}
    </div>
  );
}
