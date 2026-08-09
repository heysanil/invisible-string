/**
 * The `@` suggestion popup for the instructions editor.
 *
 * Tiptap's suggestion plugin owns the lifecycle (it decides when to open,
 * re-query and close) and hands us a plain DOM mount point, so this exports a
 * `render` factory rather than a component the tree renders directly.
 *
 * KEYBOARD OWNERSHIP: while the menu is open it must swallow ArrowUp/Down and
 * Enter, or the editor inserts a newline underneath the selection the author
 * meant to accept. `onKeyDown` returning true is what claims the key.
 */
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

import type { ReferenceOption } from "../../lib/builder/references";

interface MenuHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface MenuProps extends SuggestionProps<ReferenceOption, ReferenceOption> {}

const ReferenceMenu = forwardRef<MenuHandle, MenuProps>(function ReferenceMenu(
  { items, command },
  ref,
) {
  const [selected, setSelected] = useState(0);

  // A re-query can shrink the list under the cursor; never leave it out of range.
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (items.length === 0) return false;
      if (event.key === "ArrowUp") {
        setSelected((current) => (current + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelected((current) => (current + 1) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="tt-suggest">
        <p className="tt-suggest-empty">
          Nothing to reference yet — attach a connection or skill in Context.
        </p>
      </div>
    );
  }

  return (
    // `listbox`/`option` rather than a menu: e2e picks options by role, and
    // this is a value picker, not a command list.
    <ul className="tt-suggest" role="listbox" aria-label="Insert a reference">
      {items.map((item, index) => (
        <li key={item.label}>
          <button
            type="button"
            role="option"
            aria-selected={index === selected}
            className="tt-suggest-item"
            // Keep the editor selection intact so `command` inserts in place.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelected(index)}
            onClick={() => command(item)}
          >
            <span className="tt-suggest-label">{item.label}</span>
            <span className="tt-suggest-detail">{item.detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
});

/** Gap between the caret and the menu, and the viewport margin it respects. */
const OFFSET = 4;
const MARGIN = 8;

/**
 * Position the popup under the caret, in VIEWPORT coordinates.
 *
 * The menu is portaled to `document.body` and positioned `fixed`, which it has
 * to be: `.tt-host` is `overflow: auto` — deliberately, because it is the
 * scrollport that makes `.tt-toolbar`'s `position: sticky` work — so a
 * descendant popup would be clipped at the editor's bottom edge, exactly where
 * the caret usually is. `.tt-suggest`'s `z-index: 90` (above panels and the
 * overlay scrim, below toasts) assumes this placement.
 *
 * The cost of `fixed` is that it does not follow a scroll, so the caller
 * re-places on scroll and resize.
 */
function place(element: HTMLElement, rect: DOMRect | null) {
  if (!rect) return;
  element.style.position = "fixed";
  element.style.visibility = "hidden";
  element.style.left = "0px";
  element.style.top = "0px";

  const { width, height } = element.getBoundingClientRect();
  // Flip above the caret when there is not room below — a menu opening off
  // the bottom of the window is the common case in a tall instructions doc.
  const below = rect.bottom + OFFSET;
  const flip = below + height > window.innerHeight - MARGIN;
  const top = flip ? Math.max(MARGIN, rect.top - OFFSET - height) : below;
  const left = Math.min(
    Math.max(MARGIN, rect.left),
    Math.max(MARGIN, window.innerWidth - width - MARGIN),
  );

  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.visibility = "";
}

export function referenceSuggestionRender(): SuggestionOptions<
  ReferenceOption,
  ReferenceOption
>["render"] {
  return () => {
    let renderer: ReactRenderer<MenuHandle, MenuProps> | null = null;
    let caretRect: (() => DOMRect | null) | null = null;

    // `position: fixed` does not follow a scrolling ancestor, so re-place on
    // any scroll (capture, to catch the editor's own scrollport) and on
    // resize. Cheap: only ever bound while the menu is open.
    const reposition = () => {
      if (!renderer) return;
      place(renderer.element as HTMLElement, caretRect?.() ?? null);
    };

    return {
      onStart: (props) => {
        caretRect = props.clientRect ?? null;
        renderer = new ReactRenderer(ReferenceMenu, { props, editor: props.editor });
        // Portaled to the body — see `place`. Anything inside `.tt-host`
        // would be clipped by its `overflow: auto`.
        document.body.appendChild(renderer.element);
        place(renderer.element as HTMLElement, caretRect?.() ?? null);
        window.addEventListener("scroll", reposition, true);
        window.addEventListener("resize", reposition);
      },
      onUpdate: (props) => {
        caretRect = props.clientRect ?? null;
        renderer?.updateProps(props);
        reposition();
      },
      onKeyDown: (props) => {
        if (props.event.key === "Escape") return true;
        return renderer?.ref?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        window.removeEventListener("scroll", reposition, true);
        window.removeEventListener("resize", reposition);
        renderer?.element.remove();
        renderer?.destroy();
        renderer = null;
        caretRect = null;
      },
    };
  };
}
