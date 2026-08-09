/**
 * Extension sets for the two editor tiers.
 *
 * `document` — persona, workflow instructions, skill instructions. Full block
 * grammar; the output is a prompt read by a model, so anything markdown can
 * express is fair game.
 *
 * `chat` — the chat and copilot composers. Same grammar, no `@reference`
 * chips: a chat message is addressed to the agent, not compiled against a
 * draft's trigger fields and attached context.
 *
 * The composer used to be capped to a subset because the in-house renderer
 * could only display paragraphs, flat lists, fenced code and a few inline
 * marks — anything beyond that echoed back to the author as literal syntax.
 * Streamdown (see components/chat/Markdown.tsx) parses full GFM, so the cap
 * is gone and the two tiers differ only in references.
 */
import StarterKit from "@tiptap/starter-kit";
import type { Extensions } from "@tiptap/core";

import { faithfulMarkdown, promptMarkdown } from "./markdown";

/**
 * Autolinking rewrites a bare `https://…` into `[url](url)` on serialize,
 * which mutates prompt text the author never touched. Typed links still work.
 */
const LINK = { autolink: false, openOnClick: false } as const;

export function documentExtensions(): Extensions {
  return [
    StarterKit.configure({ link: LINK }),
    promptMarkdown,
    faithfulMarkdown,
  ] as Extensions;
}

export function chatExtensions(): Extensions {
  return [StarterKit.configure({ link: LINK }), promptMarkdown, faithfulMarkdown] as Extensions;
}

/**
 * Stable instances for surfaces that need no per-editor configuration.
 *
 * `RichTextEditor` rebuilds its editor whenever the `extensions` identity
 * changes, so a call site must never pass a freshly built array inline —
 * that would tear down and recreate the editor on every render. Surfaces
 * that DO need per-editor config (the workflow instructions editor, whose
 * reference suggestions read live draft state) build their own inside a
 * `useMemo`.
 */
export const DOCUMENT_EXTENSIONS: Extensions = documentExtensions();
export const CHAT_EXTENSIONS: Extensions = chatExtensions();
