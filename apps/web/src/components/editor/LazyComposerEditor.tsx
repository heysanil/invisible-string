/**
 * The chat-tier editor behind a code-split boundary.
 *
 * WHY ONLY THE COMPOSERS
 * ----------------------
 * The Tiptap chunk is ~140 kB gzip. On the agent / workflow / skill routes it
 * is a net WIN — it replaced a 186 kB gzip CodeMirror chunk those routes were
 * already paying for. Chat never loaded CodeMirror, so a static import there
 * would put 140 kB gzip on the critical path of the app's landing surface.
 * Splitting it keeps the thread painting immediately; the composer swaps in a
 * beat later. `builder/InstructionsPanel.tsx` splits the document editor the
 * same way for the same reason.
 *
 * The dynamic import must resolve ./ComposerEditor, not ./RichTextEditor: the
 * chat EXTENSION SET is most of the weight, so both sides have to sit beyond
 * the boundary or the split buys nothing.
 *
 * The fallback is the real capsule interior at its resting height with the
 * real placeholder — not a spinner. The composer is always on screen, so a
 * fallback of a different size would visibly reflow the thread above it the
 * moment the chunk lands.
 */
import { Suspense, lazy, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "../../lib/cn";
import type { ComposerEditorProps } from "./ComposerEditor";
import type { RichTextEditorHandle } from "./RichTextEditor";

const ComposerEditorImpl = lazy(() =>
  import("./ComposerEditor").then((module) => ({
    default: module.ComposerEditor,
  })),
);

export interface LazyComposerEditorProps extends ComposerEditorProps {
  ref?: React.Ref<RichTextEditorHandle>;
}

function Fallback({
  placeholder,
  className,
}: Pick<ComposerEditorProps, "placeholder" | "className">) {
  return (
    <div className={cn("tt-host", className)} aria-hidden="true">
      <div className="tt-content">
        <p className="tiptap tt-fallback-line">{placeholder}</p>
      </div>
    </div>
  );
}

export function LazyComposerEditor({ ref, ...props }: LazyComposerEditorProps) {
  const real = useRef<RichTextEditorHandle | null>(null);
  // A focus() that arrives before the chunk resolves must not be dropped:
  // the parent's autoFocus effect runs while Suspense is still showing the
  // fallback. Remember it and replay on attach.
  const pendingFocus = useRef(false);

  // A STABLE handle handed to the caller on the first render, so the lazy
  // boundary is invisible: `flush()` before load returns "" (the user cannot
  // have typed into a fallback), and focus is queued rather than lost.
  const proxy = useRef<RichTextEditorHandle>({
    flush: () => real.current?.flush() ?? "",
    setValue: (next) => real.current?.setValue(next),
    // Dropped before the chunk resolves, and that is correct: with no
    // document to append to, the caller's `value` prop is what seeds the
    // editor when it finally mounts.
    append: (text) => real.current?.append(text),
    focus: () => {
      if (real.current) real.current.focus();
      else pendingFocus.current = true;
    },
  });

  useImperativeHandle(ref, () => proxy.current, []);

  const attach = useCallback((instance: RichTextEditorHandle | null) => {
    real.current = instance;
    if (instance && pendingFocus.current) {
      pendingFocus.current = false;
      instance.focus();
    }
  }, []);

  return (
    <Suspense
      fallback={
        <Fallback placeholder={props.placeholder} className={props.className} />
      }
    >
      <ComposerEditorImpl {...props} ref={attach} />
    </Suspense>
  );
}
