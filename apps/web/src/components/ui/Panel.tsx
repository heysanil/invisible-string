import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type PanelProps = HTMLAttributes<HTMLElement>;

/** A floating liquid-glass surface — the basic building block of every screen. */
export function Panel({ className, ...rest }: PanelProps) {
  return <section className={cn("glass-panel", className)} {...rest} />;
}
