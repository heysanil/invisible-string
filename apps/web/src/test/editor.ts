/**
 * Driving a Tiptap composer from a DOM test.
 *
 * ProseMirror learns about typing from the browser's own editing behavior,
 * which happy-dom does not perform — `fireEvent.input` on a contenteditable
 * changes nothing, and `fireEvent.change` throws (there is no value setter).
 * `paste` is the one text-entry path that runs through an explicit handler,
 * so it stands in for typing: same document mutation, same update cycle.
 *
 * Note what it deliberately does NOT do: wait. Text landed this way is in the
 * document but not yet through `RichTextEditor`'s serialize debounce, which
 * is exactly the state a composer has to survive when Enter arrives.
 */
import { fireEvent } from "@testing-library/react";

export function pasteInto(element: HTMLElement, text: string): void {
  fireEvent.paste(element, {
    clipboardData: {
      types: ["text/plain"],
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

/** Enter — the send gesture every composer in the app shares. */
export function pressEnter(element: HTMLElement): void {
  fireEvent.keyDown(element, { key: "Enter" });
}
