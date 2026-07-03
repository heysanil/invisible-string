/**
 * CodeMirror 6 instructions editor — markdown, E1-styled (transparent bg,
 * ui-monospace @refs), with `@` autocomplete + reference decorations sourced
 * from the live draft (lib/builder/codemirror-refs.ts).
 *
 * External value changes (undo of a whole draft, copilot edits later) are
 * reconciled against the editor doc; reference sources reconfigure via a
 * StateEffect without tearing the view down.
 */
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { useEffect, useRef } from "react";

import {
  referenceExtensions,
  referenceSourcesField,
  setReferenceSources,
} from "../../lib/builder/codemirror-refs";
import type { ReferenceSources } from "../../lib/builder/references";

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
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest onChange without recreating the editor.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Create the editor once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        closeBrackets(),
        markdown(),
        cmPlaceholder(placeholder),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": ariaLabel,
          role: "textbox",
          "aria-multiline": "true",
        }),
        ...referenceExtensions(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    view.dispatch({ effects: setReferenceSources.of(sources) });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally create-once; value/sources are synced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile external value → editor doc (skip when already equal).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  // Reconfigure reference sources on change (autocomplete + decorations).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.field(referenceSourcesField) === sources) return;
    view.dispatch({ effects: setReferenceSources.of(sources) });
  }, [sources]);

  return (
    <div
      ref={hostRef}
      className="thin-scroll min-h-72 rounded-card border border-black/10 bg-white/45 px-3 py-2"
    />
  );
}
