/**
 * Deliberately small markdown parser for agent replies — block + inline
 * subset, no HTML passthrough (output is a typed AST rendered as React
 * elements, so there is no sanitization surface).
 *
 * Blocks: fenced code (``` — an UNTERMINATED fence swallows the rest, which
 * is exactly right while a reply is still streaming), headings (#–####),
 * unordered/ordered lists, blockquotes, horizontal rules, paragraphs.
 * Inline: `code`, **strong**, *em* / _em_, [text](url).
 */

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "link"; href: string; children: MdInline[] };

export type MdBlock =
  | { kind: "p"; inline: MdInline[] }
  | { kind: "h"; level: 1 | 2 | 3 | 4; inline: MdInline[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "list"; ordered: boolean; items: MdInline[][] }
  | { kind: "quote"; inline: MdInline[] }
  | { kind: "hr" };

const SAFE_LINK = /^(https?:|mailto:)/i;

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = text;

  const pushText = (chunk: string) => {
    if (chunk.length === 0) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === "text") last.text += chunk;
    else out.push({ kind: "text", text: chunk });
  };

  while (rest.length > 0) {
    // Inline code — earliest wins, contents are literal.
    const code = rest.match(/`([^`\n]+)`/);
    const strong = rest.match(/\*\*([^*\n]+)\*\*/);
    const em = rest.match(/(?<![*\w])[*_]([^*_\n]+)[*_](?![*\w])/);
    const link = rest.match(/\[([^\]\n]+)\]\(([^)\s]+)\)/);

    const candidates = [
      code ? { index: code.index ?? 0, len: code[0].length, apply: () => out.push({ kind: "code" as const, text: code[1] ?? "" }) } : null,
      strong ? { index: strong.index ?? 0, len: strong[0].length, apply: () => out.push({ kind: "strong" as const, children: parseInline(strong[1] ?? "") }) } : null,
      em ? { index: em.index ?? 0, len: em[0].length, apply: () => out.push({ kind: "em" as const, children: parseInline(em[1] ?? "") }) } : null,
      link
        ? {
            index: link.index ?? 0,
            len: link[0].length,
            apply: () => {
              const href = link[2] ?? "";
              if (SAFE_LINK.test(href)) {
                out.push({ kind: "link" as const, href, children: parseInline(link[1] ?? "") });
              } else {
                pushText(link[0]);
              }
            },
          }
        : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) {
      pushText(rest);
      break;
    }
    candidates.sort((a, b) => a.index - b.index);
    const first = candidates[0]!;
    pushText(rest.slice(0, first.index));
    first.apply();
    rest = rest.slice(first.index + first.len);
  }
  return out;
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "p", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list === null) return;
    blocks.push({
      kind: "list",
      ordered: list.ordered,
      items: list.items.map(parseInline),
    });
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    const fence = line.match(/^```([\w+-]*)\s*$/);
    if (fence !== null) {
      flushAll();
      const lang = fence[1] === "" || fence[1] === undefined ? null : fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading !== null) {
      flushAll();
      blocks.push({
        kind: "h",
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3 | 4,
        inline: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    if (/^(---+|\*\*\*+)\s*$/.test(line)) {
      flushAll();
      blocks.push({ kind: "hr" });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote !== null) {
      flushAll();
      blocks.push({ kind: "quote", inline: parseInline(quote[1] ?? "") });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const ordered = numbered !== null;
      const item = (ordered ? numbered?.[1] : bullet?.[1]) ?? "";
      if (list !== null && list.ordered === ordered) {
        list.items.push(item);
      } else {
        flushList();
        list = { ordered, items: [item] };
      }
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }
  flushAll();
  return blocks;
}
