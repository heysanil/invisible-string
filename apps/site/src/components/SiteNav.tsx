import { Link } from "@tanstack/react-router";
import { useScroll, useMotionValueEvent } from "motion/react";
import { useState } from "react";

import { cn } from "../lib/cn";
import { LogoMark } from "./LogoMark";
import { ButtonLink } from "./ui";

const GITHUB_URL = "https://github.com/heysanil/invisible-string";

/** Shared quiet-link idiom for the dock's middle group. */
const navLinkCls =
  "lift rounded-capsule px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-black/[0.04] hover:text-ink";

/**
 * Fixed top-center glass dock (the app's `.glass-dock` capsule, rotated
 * horizontal). Spool mark + wordmark, in-page + docs links, and an "Open the
 * app" ink capsule shown only when VITE_APP_URL is configured. Tightens
 * subtly once the page has scrolled.
 */
export function SiteNav() {
  const appUrl = import.meta.env.VITE_APP_URL;
  const [scrolled, setScrolled] = useState(false);
  const { scrollY } = useScroll();
  useMotionValueEvent(scrollY, "change", (y) => {
    setScrolled(y > 24);
  });

  return (
    <header className="fixed inset-x-0 top-3 z-50 flex justify-center px-3 sm:top-4">
      <nav
        aria-label="Primary"
        className={cn(
          "glass-dock flex items-center gap-1 transition-all duration-200 ease-out",
          scrolled ? "px-2.5 py-1.5 shadow-[0_10px_34px_rgba(0,0,0,0.14)]" : "px-3 py-2",
        )}
      >
        <Link
          to="/"
          className="lift flex items-center gap-2 rounded-capsule px-2 py-1 font-semibold tracking-tight text-ink"
        >
          <LogoMark size={19} />
          <span className="text-[14px]">invisible-string</span>
        </Link>

        <span aria-hidden className="mx-1 hidden h-4 w-px bg-black/10 sm:block" />

        <div className="hidden items-center sm:flex">
          {/* Router links (with a hash) so the in-page anchors also work from
              /docs — a plain <a href="#product"> would no-op off the landing. */}
          <Link to="/" hash="product" className={navLinkCls}>
            Use cases
          </Link>
          <Link to="/" hash="how" className={navLinkCls}>
            How it works
          </Link>
          <Link to="/docs" className={navLinkCls}>
            Docs
          </Link>
          <a href={GITHUB_URL} className={navLinkCls}>
            GitHub
          </a>
        </div>

        {/* Mobile-only Docs affordance. The middle group is sm-only, so keep
            Docs reachable below sm whether or not the app CTA is shown: a quiet
            link alongside "Open the app", or the primary ink capsule without. */}
        <Link
          to="/docs"
          className={cn(
            "lift ml-0.5 rounded-capsule px-3 py-1.5 text-[13px] font-medium sm:hidden",
            appUrl
              ? "text-ink-2 hover:bg-black/[0.04] hover:text-ink"
              : "bg-ink text-white",
          )}
        >
          Docs
        </Link>

        {appUrl ? (
          <>
            <span aria-hidden className="mx-1 hidden h-4 w-px bg-black/10 sm:block" />
            <ButtonLink href={appUrl} size="sm" className="ml-0.5">
              Open the app
            </ButtonLink>
          </>
        ) : null}
      </nav>
    </header>
  );
}
