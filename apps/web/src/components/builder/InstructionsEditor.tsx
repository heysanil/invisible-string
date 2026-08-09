/**
 * The workflow-instructions editor: the document tier plus `@reference` chips.
 *
 * The reference sources change as the author edits the OTHER sections (pick a
 * different agent, attach a skill), so they are pushed into the live editor
 * through a plugin transaction rather than a prop that would rebuild it —
 * the same reason the CodeMirror version used a `StateField`/`StateEffect`
 * pair instead of re-creating its view.
 */
import { useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";

import { documentExtensions } from "../../lib/editor/profiles";
import { hydrateReferences } from "../../lib/editor/hydrate";
import { Reference } from "../../lib/editor/reference";
import { setReferenceSources } from "../../lib/editor/reference-status";
import type { ReferenceSources } from "../../lib/builder/references";
import { MarkdownDocumentEditor } from "../editor/MarkdownDocumentEditor";
import { referenceSuggestionRender } from "../editor/ReferenceMenu";

export interface InstructionsEditorProps {
  value: string;
  onChange: (value: string) => void;
  sources: ReferenceSources;
  placeholder?: string;
  /** Accessible label for the editor content region. */
  ariaLabel?: string;
}

export function InstructionsEditor({
  value,
  onChange,
  sources,
  placeholder = "Write the agent's instructions…  Type @ to reference trigger fields, connections, or skills.",
  ariaLabel = "Instructions editor",
}: InstructionsEditorProps) {
  // Built once. A new identity here would tear the editor down mid-keystroke,
  // and the suggestion list reads live sources from plugin state anyway.
  const extensions = useMemo(
    () => [
      ...documentExtensions(),
      Reference.configure({ suggestion: { render: referenceSuggestionRender() } }),
    ],
    [],
  );

  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    if (!editor) return;
    setReferenceSources(editor, sources);
  }, [editor, sources]);

  return (
    <MarkdownDocumentEditor
      value={value}
      onChange={onChange}
      extensions={extensions}
      hydrate={hydrateReferences}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      className="min-h-72"
      onEditor={setEditor}
    />
  );
}
