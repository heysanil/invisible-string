import {
  cloneElement,
  useEffect,
  useId,
  useState,
  type ReactElement,
} from "react";

import { cn } from "../../lib/cn";

export interface TooltipProps {
  label: string;
  children: ReactElement<{
    "aria-describedby"?: string;
    "aria-label"?: string;
  }>;
  className?: string;
}

/**
 * Minimal, dependency-free tooltip: shows on hover and keyboard focus,
 * announced via aria-describedby, dismissable with Escape (WCAG 1.4.13)
 * without moving focus — it re-arms once the pointer leaves / focus moves.
 *
 * When the child's accessible name (aria-label) already equals the tooltip
 * text, aria-describedby is omitted so screen readers do not announce the
 * same text twice ("Chat, link, Chat").
 */
export function Tooltip({ label, children, className }: TooltipProps) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);

  // Escape must dismiss while merely hovered too (keyboard events land on
  // whatever has focus, not the hovered element) — document-level listener,
  // active only while the pointer is over the trigger.
  useEffect(() => {
    if (!hovered) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hovered]);

  const describedByRedundant = children.props["aria-label"] === label;
  const trigger = describedByRedundant
    ? children
    : cloneElement(children, { "aria-describedby": id });

  return (
    <span
      className={cn("tooltip-wrap relative inline-flex", className)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setDismissed(true);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setDismissed(false); // re-arm for the next hover
      }}
      onBlur={() => setDismissed(false)}
    >
      {trigger}
      <span role="tooltip" id={id} hidden={dismissed} className="tooltip">
        {label}
      </span>
    </span>
  );
}
