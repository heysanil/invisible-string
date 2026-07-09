import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/cn";
import type { SidebarSection } from "../../lib/sidebar";

export interface DocSidebarProps {
  sections: SidebarSection[];
  /** Currently open doc slug (drives the active ink capsule). */
  currentSlug: string;
  /** Fired after a link is chosen — lets the mobile drawer close itself. */
  onNavigate?: () => void;
}

/**
 * Docs navigation: sections as small-caps labels, links as quiet rows that
 * become an ink capsule when active (mirrors the app dock's active state).
 * Rendered both in the desktop rail and inside the mobile disclosure.
 */
export function DocSidebar({ sections, currentSlug, onNavigate }: DocSidebarProps) {
  return (
    <nav className="flex flex-col gap-7" aria-label="Documentation">
      {sections.map((section) => (
        <div key={section.section} className="flex flex-col gap-1.5">
          <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-4">
            {section.section}
          </p>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = item.slug === currentSlug;
              return (
                <li key={item.slug}>
                  <Link
                    to="/docs/$"
                    params={{ _splat: item.slug }}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "lift block rounded-capsule px-3 py-1.5 text-[13.5px] leading-snug",
                      active
                        ? "bg-ink font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.16)]"
                        : "text-ink-2 hover:bg-black/[0.04] hover:text-ink",
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
