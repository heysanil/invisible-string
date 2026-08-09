/**
 * The Tiptap editor behind every prompt surface.
 *
 * Deliberately mirrors the `CodeMirrorMarkdown` contract it replaces —
 * `{ value, onChange, placeholder, ariaLabel, readOnly }`, markdown string in,
 * markdown string out — so reducers, autosave debounces and the copilot's
 * whole-document apply path need no changes.
 *
 * TWO THINGS HERE ARE NOT OBVIOUS
 * -------------------------------
 * 1. `onChange` is DEBOUNCED, unlike the CodeMirror components which fire per
 *    keystroke. Serializing is super-linear (~1 ms at 1 k chars, ~9 ms at 6 k,
 *    ~170 ms at 28 k — see lib/editor/markdown.ts), because the faithful
 *    serializer re-parses its own output to prove it is stable. Running that
 *    on every keypress would stall typing in a long persona. Callers that need
 *    the current value synchronously (publish, test-run, tab-away) call
 *    `flush()` on the ref.
 * 2. External writes must not echo back. The copilot replaces the whole
 *    document; `applyExternalValue` marks that transaction so `onUpdate`
 *    ignores it. Without this the editor would immediately re-serialize the
 *    copilot's markdown and hand back a normalized variant, re-keying the
 *    agent's content hash for a change the user never made.
 */
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Placeholder } from "@tiptap/extensions";
import type { Extensions, JSONContent } from "@tiptap/core";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

import { cn } from "../../lib/cn";

/** Idle gap before a keystroke turns into a serialize + `onChange`. */
const SERIALIZE_DEBOUNCE_MS = 180;

/** Marks a transaction as programmatic so `onUpdate` does not echo it back. */
const EXTERNAL = "externalValue";

/**
 * Tiptap nulls its internals on `destroy()`, so a destroyed instance is still
 * a non-null object whose `commands` / `chain()` getters throw. `?.` on the
 * editor is therefore NOT enough — every entry point has to check liveness.
 *
 * This is reachable in normal operation: `<StrictMode>` (see main.tsx)
 * double-invokes effects, so `useEditor` creates → destroys → recreates on
 * mount, and the copilot dock focuses its composer on open. It does not
 * reproduce under Testing Library, which does not wrap in StrictMode — the
 * e2e suite is what caught it.
 */
function isLive(editor: Editor | null): editor is Editor {
  return editor !== null && !editor.isDestroyed;
}

export interface RichTextEditorHandle {
  /** Serialize now and deliver through `onChange`. Returns the markdown. */
  flush: () => string;
  /**
   * Replace the document, the way the reconcile effect below does.
   *
   * The `value` prop cannot express every replacement: a composer that sends
   * and clears goes `"" → (typed) → ""` within ONE React batch, so the prop
   * lands back on the value it already had and the effect never fires. An
   * imperative write is the only reset that always takes.
   */
  setValue: (next: string) => void;
  focus: () => void;
}

export interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Extension set — `documentExtensions()` or `chatExtensions()`. */
  extensions: Extensions;
  placeholder?: string;
  ariaLabel: string;
  readOnly?: boolean;
  className?: string;
  /** Rendered above the editable area, inside the host (the toolbar slot). */
  chrome?: (editor: Editor) => React.ReactNode;
  onKeyDown?: (event: KeyboardEvent) => boolean;
  /**
   * Post-process the parsed document before it reaches the editor — how
   * `@reference` chips are rebuilt from the literal `@trigger.email` text in
   * the stored markdown (see lib/editor/hydrate.ts). Serialization is the
   * exact inverse, so the stored bytes never change.
   */
  hydrate?: (doc: JSONContent) => JSONContent;
  /**
   * Called with the editor once it exists (and with null on teardown), so a
   * caller can push plugin state into the live instance. Fired from an effect,
   * never during render.
   */
  onEditor?: (editor: Editor | null) => void;
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  function RichTextEditor(
    {
      value,
      onChange,
      extensions,
      placeholder,
      ariaLabel,
      readOnly = false,
      className,
      chrome,
      onKeyDown,
      hydrate,
      onEditor,
    },
    ref,
  ) {
    // Keep the latest callbacks without re-creating the editor each render.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onKeyDownRef = useRef(onKeyDown);
    onKeyDownRef.current = onKeyDown;
    const hydrateRef = useRef(hydrate);
    hydrateRef.current = hydrate;

    // The markdown we last handed out or took in. Guards the reconcile effect
    // below from clobbering the caret when our own onChange round-trips back.
    const lastValueRef = useRef(value);
    // Hydrating editors mount empty and are seeded by the reconcile effect;
    // without this the initial value would be skipped as "already applied".
    const seededRef = useRef(!hydrate);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Mirrors `editor` so the unmount cleanup can reach it without taking a
    // dependency that would re-register the cleanup on every recreation.
    const editorRef = useRef<Editor | null>(null);

    const editor = useEditor(
      {
        extensions: [
          ...extensions,
          Placeholder.configure({ placeholder: placeholder ?? "" }),
        ],
        content: hydrate ? "" : value,
        // Parse the initial document as markdown rather than HTML/JSON.
        contentType: "markdown",
        editable: !readOnly,
        editorProps: {
          attributes: {
            // e2e drives these editors by role + accessible name, and the
            // a11y suite asserts them. ProseMirror sets contenteditable but
            // not the name, so both must be explicit.
            "aria-label": ariaLabel,
            "aria-multiline": "true",
            role: "textbox",
            class: "tiptap",
          },
          handleKeyDown: (_view, event) => onKeyDownRef.current?.(event) ?? false,
        },
        // Commit on blur. Publish and Save read the PARENT's state, and a
        // click on either blurs the contenteditable first (mousedown → blur →
        // click), so this is what stops "type, immediately publish" from
        // shipping the markdown from one debounce ago. There is no keyboard
        // publish shortcut, so blur covers every path to those actions.
        onBlur: ({ editor: instance }) => {
          if (!timerRef.current) return;
          clearTimeout(timerRef.current);
          timerRef.current = null;
          if (!isLive(instance)) return;
          const markdown = instance.getMarkdown();
          if (markdown === lastValueRef.current) return;
          lastValueRef.current = markdown;
          onChangeRef.current(markdown);
        },
        onUpdate: ({ editor: instance, transaction }) => {
          if (!transaction.docChanged) return;
          if (transaction.getMeta(EXTERNAL)) return;
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            const markdown = instance.getMarkdown();
            lastValueRef.current = markdown;
            onChangeRef.current(markdown);
          }, SERIALIZE_DEBOUNCE_MS);
        },
      },
      // Recreate only on identity changes that alter the schema or the
      // accessible name — never on `value`, which is reconciled below.
      [extensions, ariaLabel, placeholder],
    );

    editorRef.current = editor;

    const flush = useCallback(() => {
      if (!isLive(editor)) return lastValueRef.current;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const markdown = editor.getMarkdown();
      if (markdown !== lastValueRef.current) {
        lastValueRef.current = markdown;
        onChangeRef.current(markdown);
      }
      return markdown;
    }, [editor]);

    // The one external-write path, shared by the reconcile effect below and
    // the imperative `setValue`.
    const applyExternalValue = useCallback(
      (next: string) => {
        if (!isLive(editor)) return;
        seededRef.current = true;
        lastValueRef.current = next;
        const transform = hydrateRef.current;
        if (!transform) {
          editor
            .chain()
            .setMeta(EXTERNAL, true)
            .setContent(next, { contentType: "markdown", emitUpdate: false })
            .run();
          return;
        }
        // Parse and transform in two steps — `setContent(md, {contentType})`
        // is atomic, leaving nowhere to rebuild the reference chips.
        const parsed = editor.markdown?.parse(next);
        editor
          .chain()
          .setMeta(EXTERNAL, true)
          .setContent(parsed ? transform(parsed) : next, { emitUpdate: false })
          .run();
      },
      [editor],
    );

    useImperativeHandle(
      ref,
      () => ({
        flush,
        setValue: (next: string) => {
          // A serialize still in the debounce would fire after this write and
          // hand the caller back the value it just replaced.
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          applyExternalValue(next);
        },
        focus: () => {
          if (!isLive(editor)) return;
          editor.commands.focus();
        },
      }),
      [editor, flush, applyExternalValue],
    );

    // Reconcile external value changes (copilot apply, loading a different
    // entity, draft undo) without disturbing the caret during normal typing.
    useEffect(() => {
      if (!isLive(editor)) return;
      if (value === lastValueRef.current && seededRef.current) return;
      applyExternalValue(value);
    }, [editor, value, applyExternalValue]);

    useEffect(() => {
      if (!isLive(editor)) return;
      editor.setEditable(!readOnly);
    }, [editor, readOnly]);

    const onEditorRef = useRef(onEditor);
    onEditorRef.current = onEditor;
    useEffect(() => {
      onEditorRef.current?.(editor ?? null);
      return () => onEditorRef.current?.(null);
    }, [editor]);

    // A pending serialize must still LAND if the surface unmounts mid-edit
    // (route change, drawer close, switching entity) — otherwise the last
    // keystrokes are dropped from draft state and silently lost.
    //
    // `useLayoutEffect` on purpose: layout cleanups run before passive ones,
    // and `useEditor` destroys the instance in a passive cleanup. Registering
    // this passively would hand us an already-destroyed editor with nothing
    // left to serialize.
    useLayoutEffect(
      () => () => {
        if (!timerRef.current) return;
        clearTimeout(timerRef.current);
        timerRef.current = null;
        const instance = editorRef.current;
        if (!isLive(instance)) return;
        const markdown = instance.getMarkdown();
        if (markdown === lastValueRef.current) return;
        lastValueRef.current = markdown;
        onChangeRef.current(markdown);
      },
      [],
    );

    return (
      <div className={cn("tt-host", readOnly && "tt-host-readonly", className)}>
        {editor && chrome ? chrome(editor) : null}
        <EditorContent editor={editor} className="tt-content" />
      </div>
    );
  },
);
