import { cn } from "../../lib/cn";

export interface SpinnerProps {
  size?: number;
  className?: string;
}

export function Spinner({ size = 14, className }: SpinnerProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("spinner shrink-0", className)}
      style={{ width: size, height: size }}
    />
  );
}
