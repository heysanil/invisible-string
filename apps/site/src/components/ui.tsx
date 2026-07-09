import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn";

/* ---------------------------------------------------------------------------
   Site-local E1 primitives. App components aren't importable across apps, and
   the marketing site wants its own (larger) variants — so these are ports of
   the apps/web class-string idioms (Button / Panel / Chip / StatusChip).
--------------------------------------------------------------------------- */

/* --- Button --------------------------------------------------------------- */

export type ButtonVariant = "primary" | "ghost" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_BASE =
  "lift inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-capsule font-medium disabled:pointer-events-none disabled:opacity-55";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-ink text-white shadow-[0_1px_2px_rgba(0,0,0,0.16)] hover:shadow-[0_5px_16px_rgba(0,0,0,0.22)]",
  ghost:
    "border border-black/10 bg-white/40 text-ink hover:border-black/15 hover:bg-white/70",
  quiet: "text-ink-2 hover:bg-black/[0.04] hover:text-ink",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3.5 text-[13px]",
  md: "h-10 px-5 text-sm",
  lg: "h-12 px-6 text-[15px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, type, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      {...rest}
    >
      {children}
    </button>
  );
});

export interface ButtonLinkProps
  extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Anchor styled as a Button — for external links / CTAs rendered as `<a>`. */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  function ButtonLink({ variant = "primary", size = "md", className, children, ...rest }, ref) {
    return (
      <a
        ref={ref}
        className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
        {...rest}
      >
        {children}
      </a>
    );
  },
);

/* --- GlassPanel ----------------------------------------------------------- */

export interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Section/card wrapper using the shared `.glass-panel` surface. */
export function GlassPanel({ className, children, ...rest }: GlassPanelProps) {
  return (
    <div className={cn("glass-panel", className)} {...rest}>
      {children}
    </div>
  );
}

/* --- Chip / StatusChip ---------------------------------------------------- */

export type ChipTone = "neutral" | "ok" | "warn" | "err" | "ink";

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: "bg-black/[0.05] text-ink-2",
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/15 text-warn-ink",
  err: "bg-err/12 text-err",
  ink: "bg-ink text-white",
};

const CHIP_DOT: Record<ChipTone, string> = {
  neutral: "bg-ink-4",
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  ink: "bg-white",
};

export interface ChipProps {
  children: ReactNode;
  tone?: ChipTone;
  /** Small leading dot (semantic status). */
  dot?: boolean;
  className?: string;
  title?: string;
}

/** Capsule label — status, role, count, feature tag. */
export function Chip({ children, tone = "neutral", dot = false, className, title }: ChipProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-capsule px-2.5 py-1 text-[12px] font-medium leading-none",
        CHIP_TONE[tone],
        className,
      )}
    >
      {dot ? (
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", CHIP_DOT[tone])} />
      ) : null}
      {children}
    </span>
  );
}

export interface StatusChipProps {
  children: ReactNode;
  tone?: ChipTone;
  /** Show a leading state dot (semantic color = meaning). */
  dot?: boolean;
  className?: string;
  title?: string;
}

/** Compact capsule state chip — the E1 way to show meaning-as-color. */
export function StatusChip({
  children,
  tone = "neutral",
  dot = false,
  className,
  title,
}: StatusChipProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-capsule px-2 py-0.5 text-[11px] font-medium",
        CHIP_TONE[tone],
        className,
      )}
    >
      {dot ? (
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", CHIP_DOT[tone])} />
      ) : null}
      {children}
    </span>
  );
}
