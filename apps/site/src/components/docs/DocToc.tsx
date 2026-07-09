import { cn } from "../../lib/cn";
import type { TocEntry } from "../../lib/toc";

export interface DocTocProps {
  entries: TocEntry[];
  /** Id of the heading currently in view (scrollspy); optional. */
  activeId?: string | null;
}

/**
 * "On this page" rail — flat list of h2/h3 links extracted from the rendered
 * article. h3s indent one step. The active heading (scrollspy) gets an ink
 * marker; without a match the rail is simply quiet.
 */
export function DocToc({ entries, activeId }: DocTocProps) {
  if (entries.length === 0) return null;

  return (
    <nav aria-label="On this page" className="flex flex-col gap-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-4">
        On this page
      </p>
      <ul className="flex flex-col gap-1.5 border-l border-hairline">
        {entries.map((entry) => {
          const active = entry.id === activeId;
          return (
            <li key={entry.id} style={{ paddingLeft: entry.depth === 3 ? "1.5rem" : "0.75rem" }}>
              <a
                href={`#${entry.id}`}
                aria-current={active ? "location" : undefined}
                className={cn(
                  "lift -ml-px block border-l-2 py-0.5 text-[13px] leading-snug",
                  active
                    ? "border-ink font-medium text-ink"
                    : "border-transparent text-ink-3 hover:text-ink",
                )}
              >
                {entry.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
