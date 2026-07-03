import { cloneElement, useId, type ReactElement } from "react";

import { cn } from "../../lib/cn";

export interface TooltipProps {
  label: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
  className?: string;
}

/**
 * Minimal, dependency-free tooltip: shows on hover and keyboard focus,
 * announced via aria-describedby.
 */
export function Tooltip({ label, children, className }: TooltipProps) {
  const id = useId();
  return (
    <span className={cn("tooltip-wrap relative inline-flex", className)}>
      {cloneElement(children, { "aria-describedby": id })}
      <span role="tooltip" id={id} className="tooltip">
        {label}
      </span>
    </span>
  );
}
