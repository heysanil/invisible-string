import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";

import type { FlatDoc } from "../../lib/sidebar";

export interface DocPagerProps {
  prev: FlatDoc | null;
  next: FlatDoc | null;
}

/** Prev/next pagination capsules at the article foot, from sidebar order. */
export function DocPager({ prev, next }: DocPagerProps) {
  if (!prev && !next) return null;

  return (
    <nav
      aria-label="Pagination"
      className="mt-14 grid grid-cols-1 gap-3 border-t border-hairline pt-8 sm:grid-cols-2"
    >
      {prev ? (
        <Link
          to="/docs/$"
          params={{ _splat: prev.slug }}
          className="lift glass-panel group flex flex-col gap-1 rounded-panel-sm px-4 py-3"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-4">
            <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" />
            Previous
          </span>
          <span className="text-sm font-medium text-ink">{prev.title}</span>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      {next ? (
        <Link
          to="/docs/$"
          params={{ _splat: next.slug }}
          className="lift glass-panel group flex flex-col items-end gap-1 rounded-panel-sm px-4 py-3 text-right sm:col-start-2"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-4">
            Next
            <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span className="text-sm font-medium text-ink">{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}
