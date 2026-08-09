/**
 * The document-tier prompt editor: glass toolbar, `@` references, and a
 * Rich ⇄ Markdown toggle.
 *
 * The source view is not a nicety. The stored string is compiled verbatim into
 * `agent/instructions.md` and hashed into the agent's build identity, and the
 * `@reference` grammar is lexical (it matches inside code fences too), so an
 * author debugging a publish error needs to see the literal bytes. It is a
 * plain monospace textarea on purpose — anything richer would be another layer
 * between the author and the text.
 */
import { useCallback, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { Extensions, JSONContent } from "@tiptap/core";

import { cn } from "../../lib/cn";
import { SegmentedControl } from "../ui/SegmentedControl";
import { EditorToolbar } from "./EditorToolbar";
import {
  RichTextEditor,
  type RichTextEditorHandle,
} from "./RichTextEditor";

type Mode = "rich" | "source";

const MODES = [
  { value: "rich" as const, label: "Rich" },
  { value: "source" as const, label: "Markdown" },
];

export interface MarkdownDocumentEditorProps {
  value: string;
  onChange: (value: string) => void;
  extensions: Extensions;
  ariaLabel: string;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  /** Rendered under the editor — character counts, reference legends. */
  footer?: React.ReactNode;
  /** Rebuild nodes the markdown grammar cannot express — see RichTextEditor. */
  hydrate?: (doc: JSONContent) => JSONContent;
  /** Handed the live editor so a caller can push plugin state into it. */
  onEditor?: (editor: Editor | null) => void;
}

export function MarkdownDocumentEditor({
  value,
  onChange,
  extensions,
  ariaLabel,
  placeholder,
  readOnly = false,
  className,
  footer,
  hydrate,
  onEditor,
}: MarkdownDocumentEditorProps) {
  const [mode, setMode] = useState<Mode>("rich");
  const editorRef = useRef<RichTextEditorHandle>(null);

  // Leaving rich mode must not lose the keystrokes still sitting in the
  // serialize debounce — flush before the textarea reads `value`.
  const changeMode = useCallback((next: Mode) => {
    if (next === "source") editorRef.current?.flush();
    setMode(next);
  }, []);

  const toggle = (
    <SegmentedControl
      value={mode}
      onChange={changeMode}
      options={MODES}
      ariaLabel="Editor mode"
      size="sm"
      variant="radio"
    />
  );

  return (
    <div className={cn("flex min-h-0 flex-col gap-1.5", className)}>
      {mode === "rich" ? (
        <RichTextEditor
          ref={editorRef}
          value={value}
          onChange={onChange}
          extensions={extensions}
          ariaLabel={ariaLabel}
          placeholder={placeholder}
          readOnly={readOnly}
          hydrate={hydrate}
          onEditor={onEditor}
          chrome={(editor: Editor) =>
            readOnly ? null : <EditorToolbar editor={editor} trailing={toggle} />
          }
        />
      ) : (
        <div className="tt-host">
          {readOnly ? null : (
            <div className="tt-toolbar">
              <div className="tt-toolbar-trailing">{toggle}</div>
            </div>
          )}
          <textarea
            aria-label={`${ariaLabel} (markdown source)`}
            value={value}
            readOnly={readOnly}
            spellCheck={false}
            placeholder={placeholder}
            // The repo's Input/Textarea primitives do the same dance: React's
            // ChangeEventPlugin never fires under happy-dom, so tests would
            // never observe a keystroke through onChange alone.
            onChange={() => {}}
            onInput={(event) => onChange(event.currentTarget.value)}
            className="tt-source"
          />
        </div>
      )}
      {footer}
    </div>
  );
}
