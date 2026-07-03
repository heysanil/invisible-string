import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "ghost" | "quiet";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a subtle spinner and disables the control. */
  loading?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-ink text-white shadow-[0_1px_2px_rgba(0,0,0,0.16)] hover:shadow-[0_5px_16px_rgba(0,0,0,0.22)]",
  ghost:
    "border border-black/10 bg-white/40 text-ink hover:border-black/15 hover:bg-white/70",
  quiet: "text-ink-2 hover:bg-black/[0.04] hover:text-ink",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3.5 text-[13px]",
  md: "h-10 gap-2 px-5 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      loading = false,
      className,
      children,
      disabled,
      type,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          "lift inline-flex select-none items-center justify-center whitespace-nowrap rounded-capsule font-medium",
          "disabled:pointer-events-none disabled:opacity-55",
          VARIANT[variant],
          SIZE[size],
          className,
        )}
        {...rest}
      >
        {loading ? <Spinner size={13} /> : null}
        {children}
      </button>
    );
  },
);
