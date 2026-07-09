import { Link } from "@tanstack/react-router";

import { LogoMark } from "./LogoMark";

const GITHUB_URL = "https://github.com/heysanil/invisible-string";

/**
 * Footer. The invisible string's terminus: the thread descends from the page
 * and coils back into the spool ("the string ties the knot"), then a hairline
 * rule and the link rows.
 */
export function SiteFooter() {
  return (
    <footer className="site-container pb-14 pt-4">
      {/* Thread winds into the spool. */}
      <div className="relative flex flex-col items-center">
        <svg
          aria-hidden
          width="120"
          height="88"
          viewBox="0 0 120 88"
          fill="none"
          className="text-ink"
        >
          <path
            d="M60 0 C60 26, 60 34, 62 42 C 66 58, 84 58, 82 44 C 80 33, 66 34, 60 46 C 56 54, 60 62, 60 66"
            stroke="var(--thread)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <div className="-mt-5 flex size-12 items-center justify-center rounded-panel-sm bg-ink text-white">
          <LogoMark size={24} />
        </div>
      </div>

      <div className="mt-10 flex flex-col items-center gap-6 border-t border-hairline pt-8 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-2 text-ink-2">
          <LogoMark size={17} />
          <span className="text-[13.5px] font-semibold tracking-tight text-ink">
            invisible-string
          </span>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px]">
          {/* Router links (with a hash) so the anchors also work from /docs —
              a plain <a href="#product"> would no-op off the landing. */}
          <Link to="/" hash="product" className="lift text-ink-2 hover:text-ink">
            Use cases
          </Link>
          <Link to="/" hash="how" className="lift text-ink-2 hover:text-ink">
            How it works
          </Link>
          <Link to="/docs" className="lift text-ink-2 hover:text-ink">
            Docs
          </Link>
          <a href={GITHUB_URL} className="lift text-ink-2 hover:text-ink">
            GitHub
          </a>
        </nav>

        <p className="text-[12px] text-ink-2">Describe. Publish. Done.</p>
      </div>
    </footer>
  );
}
