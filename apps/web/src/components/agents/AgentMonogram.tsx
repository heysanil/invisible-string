/**
 * Ink monogram — the agent's "face": 1–2 initials in a circle, pure
 * monochrome (E1: color only as meaning). Active/selected contexts get the
 * solid-ink treatment; rest state is the quiet wash. Decorative by default —
 * the agent's name is always rendered alongside.
 */
import { cn } from "../../lib/cn";

export type AgentMonogramSize = "sm" | "md" | "lg";

const SIZE: Record<AgentMonogramSize, string> = {
  sm: "size-7 text-[11px]",
  md: "size-9 text-[13px]",
  lg: "size-11 text-[15px]",
};

export interface AgentMonogramProps {
  /** Agent name — initials are derived from its first two words. */
  name: string;
  size?: AgentMonogramSize;
  /** Solid-ink treatment (selected/active contexts). */
  active?: boolean;
  className?: string;
}

/** First letters of the first two words, uppercased ("Executive assistant" → "EA"). */
export function monogramInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

export function AgentMonogram({
  name,
  size = "md",
  active = false,
  className,
}: AgentMonogramProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-semibold tracking-wide",
        SIZE[size],
        active ? "bg-ink text-white" : "bg-black/[0.05] text-ink-3",
        className,
      )}
    >
      {monogramInitials(name)}
    </span>
  );
}
