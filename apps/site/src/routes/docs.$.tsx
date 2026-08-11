import { createFileRoute, Link } from "@tanstack/react-router";
import {
  type ComponentType,
  lazy,
  type RefObject,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  DocBreadcrumb,
  DocPager,
  DocSidebar,
  DocToc,
  MobileDocNav,
  useActiveHeading,
} from "../components/docs";
import { docFrontmatterList, getDocLoader } from "../lib/docs";
import { buildSidebar, docNeighbours, flattenSidebar } from "../lib/sidebar";
import { extractToc, type TocEntry } from "../lib/toc";

export const Route = createFileRoute("/docs/$")({ component: DocPage });

function DocPage() {
  const { _splat } = Route.useParams();
  const slug = _splat ?? "";

  const sections = useMemo(() => buildSidebar(docFrontmatterList), []);
  const flat = useMemo(() => flattenSidebar(sections), [sections]);
  const current = useMemo(() => flat.find((d) => d.slug === slug) ?? null, [flat, slug]);
  const { prev, next } = useMemo(() => docNeighbours(flat, slug), [flat, slug]);

  const loader = getDocLoader(slug);
  const MdxDoc = useMemo(() => (loader ? lazy(loader) : null), [loader]);

  const [toc, setToc] = useState<TocEntry[]>([]);
  const activeId = useActiveHeading(toc);

  // Clear the TOC across a navigation; the renderer re-populates it after the
  // new article mounts (also covers navigating into a not-found slug).
  useEffect(() => setToc([]), [slug]);

  const found = MdxDoc && current;

  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12 xl:grid-cols-[15rem_minmax(0,1fr)_14rem]">
      <aside className="hidden self-start lg:sticky lg:top-28 lg:block" aria-label="Documentation">
        <DocSidebar sections={sections} currentSlug={slug} />
      </aside>

      <main className="min-w-0">
        <MobileDocNav
          sections={sections}
          currentSlug={slug}
          currentTitle={current?.title ?? "Not found"}
        />

        <div className="mt-6 lg:mt-0">
          {found ? (
            <>
              <DocBreadcrumb section={current.section} title={current.title} />
              <MdxRenderer key={slug} MdxDoc={MdxDoc} onToc={setToc} />
              <DocPager prev={prev} next={next} />
            </>
          ) : (
            <DocNotFound slug={slug} />
          )}
        </div>
      </main>

      <aside className="hidden self-start xl:sticky xl:top-28 xl:block" aria-label="On this page">
        <DocToc entries={toc} activeId={activeId} />
      </aside>
    </div>
  );
}

/**
 * Renders the lazy MDX body inside the `.doc-prose` article and, once mounted,
 * extracts its heading outline. Lives inside `<Suspense>` so the effect fires
 * only after real content (not the fallback) is in the DOM. Keyed by slug in the
 * parent so navigation remounts it and re-extracts.
 */
function MdxRenderer({
  MdxDoc,
  onToc,
}: {
  MdxDoc: ComponentType<Record<string, unknown>>;
  onToc: (entries: TocEntry[]) => void;
}) {
  const ref = useRef<HTMLElement>(null);

  return (
    <Suspense fallback={<p className="text-sm text-ink-3">Loading…</p>}>
      <article ref={ref} className="doc-prose">
        <MdxDoc />
      </article>
      <TocReporter target={ref} onToc={onToc} />
    </Suspense>
  );
}

/** Reports the extracted TOC after the article commits to the DOM. */
function TocReporter({
  target,
  onToc,
}: {
  target: RefObject<HTMLElement | null>;
  onToc: (entries: TocEntry[]) => void;
}) {
  // Extract exactly once, after the article commits. TocReporter remounts on
  // every navigation (MdxRenderer is keyed by slug), so one extraction per mount
  // is sufficient — an unguarded effect re-fires each commit and, because
  // extractToc returns a fresh array that feeds setToc in the parent, loops
  // indefinitely ("Maximum update depth exceeded").
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (target.current) onToc(extractToc(target.current));
  }, []);
  return null;
}

/** Designed not-found for an unknown doc slug. */
function DocNotFound({ slug }: { slug: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-start justify-center gap-4">
      <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-ink-4">
        Doc not found
      </p>
      <h1 className="text-display-2">No page at that path.</h1>
      <p className="max-w-md text-ink-3">
        <code className="mono-chip">{slug || "(empty)"}</code> doesn&rsquo;t match any
        documentation page.
      </p>
      <Link
        to="/docs"
        className="lift text-sm font-medium text-ink underline underline-offset-4"
      >
        Back to docs
      </Link>
    </div>
  );
}
