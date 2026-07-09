import { useEffect, useState } from "react";

import type { TocEntry } from "../../lib/toc";

/**
 * Scrollspy: returns the id of the heading nearest the top of the viewport.
 * Uses IntersectionObserver (guarded — SSR/older engines just get `null`, and
 * the TOC renders quietly). Re-observes whenever the entry set changes.
 */
export function useActiveHeading(entries: TocEntry[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  // Stable key so the effect only re-runs when the actual ids change.
  const key = entries.map((e) => e.id).join("|");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || entries.length === 0) {
      setActiveId(null);
      return;
    }

    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          seen.set(record.target.id, record.isIntersecting);
        }
        // First heading currently intersecting, in document order.
        const current = entries.find((e) => seen.get(e.id));
        if (current) setActiveId(current.id);
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );

    const nodes: Element[] = [];
    for (const entry of entries) {
      const node = document.getElementById(entry.id);
      if (node) {
        observer.observe(node);
        nodes.push(node);
      }
    }
    setActiveId(entries[0]?.id ?? null);

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return activeId;
}
