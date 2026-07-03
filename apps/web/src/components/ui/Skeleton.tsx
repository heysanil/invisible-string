import { cn } from "../../lib/cn";

/** Shimmerless, low-key placeholder block (respects reduced-motion by design). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-[10px] bg-black/[0.06]", className)}
    />
  );
}

/** A vertical stack of skeleton rows for list/card loading states. */
export function SkeletonList({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}
