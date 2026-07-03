/**
 * Minimal CodeMirror 6 markdown editor, styled to the E1 glass system.
 * Controlled-ish: external `value` changes are reconciled into the document,
 * and edits are pushed back through `onChange`. Kept dependency-light (state,
 * view, commands, markdown language) — no theme package, our CSS owns looks.
 */
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

export interface CodeMirrorMarkdownProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  readOnly?: boolean;
}

export function CodeMirrorMarkdown({
  value,
  onChange,
  placeholder,
  ariaLabel,
  readOnly = false,
}: CodeMirrorMarkdownProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest onChange without re-creating the editor each render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      EditorView.lineWrapping,
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
      EditorView.contentAttributes.of({
        "aria-label": ariaLabel,
        role: "textbox",
        "aria-multiline": "true",
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];
    if (placeholder) extensions.push(placeholderExt(placeholder));

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: value, extensions }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Editor is created once; value is reconciled in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ariaLabel, placeholder, readOnly]);

  // Reconcile external value changes (e.g. loading a different skill) without
  // clobbering the cursor while the user is typing.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className="cm-host h-full min-h-0 w-full overflow-auto rounded-[16px] border border-black/10 bg-white/60 text-sm"
    />
  );
}
