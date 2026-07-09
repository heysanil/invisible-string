import { PenLine } from "lucide-react";

export interface UnderConstructionProps {
  /** Optional override for the muted second line. */
  note?: string;
}

/**
 * E1 EmptyState-style "this page is being written" card. Ported from the app's
 * `EmptyState` idiom (circular icon chip → title → muted line) as an ink-on-
 * glass callout so a placeholder doc still reads as designed, never blank.
 * Imported directly by every placeholder MDX file (no MDX provider is wired).
 */
export function UnderConstruction({
  note = "We're expanding this page with full detail. In the meantime, the sections above capture how it actually works today.",
}: UnderConstructionProps) {
  return (
    <aside className="doc-construction" role="note">
      <span className="doc-construction__icon" aria-hidden="true">
        <PenLine size={20} strokeWidth={1.75} />
      </span>
      <div className="doc-construction__body">
        <p className="doc-construction__title">This page is being written</p>
        <p className="doc-construction__note">{note}</p>
      </div>
    </aside>
  );
}
