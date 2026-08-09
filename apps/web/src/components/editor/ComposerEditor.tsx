/**
 * The chat-tier editor: `RichTextEditor` bound to the chat profile.
 *
 * This module exists purely as a code-splitting seam. Splitting the COMPONENT
 * alone achieves nothing — `CHAT_EXTENSIONS` statically pulls StarterKit,
 * ProseMirror and the markdown bridge, so a composer importing the profile
 * directly drags the whole ~134 kB gzip chunk onto the chat route regardless
 * of how the component is loaded. Both sides of the dependency have to live
 * behind the same dynamic import; see ./LazyComposerEditor.tsx.
 */
import { forwardRef } from "react";

import { CHAT_EXTENSIONS } from "../../lib/editor/profiles";
import {
  RichTextEditor,
  type RichTextEditorHandle,
  type RichTextEditorProps,
} from "./RichTextEditor";

export type ComposerEditorProps = Omit<RichTextEditorProps, "extensions">;

export const ComposerEditor = forwardRef<RichTextEditorHandle, ComposerEditorProps>(
  function ComposerEditor(props, ref) {
    return <RichTextEditor ref={ref} extensions={CHAT_EXTENSIONS} {...props} />;
  },
);
