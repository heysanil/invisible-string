export interface DocBreadcrumbProps {
  section: string;
  title: string;
}

/** Section / title breadcrumb above the article. Purely textual, hairline-toned. */
export function DocBreadcrumb({ section, title }: DocBreadcrumbProps) {
  return (
    <p className="mb-3 flex items-center gap-1.5 text-[12px] font-medium tracking-tight text-ink-4">
      <span>{section}</span>
      <span aria-hidden="true" className="text-ink-4/60">
        /
      </span>
      <span className="text-ink-2">{title}</span>
    </p>
  );
}
