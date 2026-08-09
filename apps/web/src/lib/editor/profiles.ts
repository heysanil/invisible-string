/**
 * Extension sets for the two editor tiers.
 *
 * `document` — persona, workflow instructions, skill instructions. Full block
 * grammar; the output is a prompt read by a model, so anything markdown can
 * express is fair game.
 *
 * `chat` — the chat and copilot composers. Deliberately CAPPED to what the
 * in-house renderer (lib/chat/markdown.ts) can display: paragraphs, h1–h4,
 * fenced code, flat lists, blockquote, hr, and inline code/strong/em/link.
 * Anything the composer can emit but the renderer cannot parse would echo
 * back to the author as literal syntax, so the two must not drift —
 * __tests__/editor-markdown.test.ts asserts exactly that.
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
  return [
    StarterKit.configure({
      link: LINK,
      // Not renderable by lib/chat/markdown.ts — see the file header.
      strike: false,
    }),
    promptMarkdown,
    faithfulMarkdown,
  ] as Extensions;
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
