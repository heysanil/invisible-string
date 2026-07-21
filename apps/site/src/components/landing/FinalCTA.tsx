import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { GlassPanel } from "../ui";
import { btnGhostLg, btnPrimaryLg, GithubGlyph, Reveal } from "./parts";

const GITHUB_URL = "https://github.com/heysanil/invisible-string";

export function FinalCTA() {
  return (
    <section className="site-container section-block">
      <Reveal>
        <GlassPanel className="flex flex-col items-center gap-6 px-6 py-16 text-center sm:py-20">
          <h2 className="text-display-2 text-balance">Describe. Delegate. Done.</h2>
          <p className="max-w-xl text-lede text-ink-2">
            Your first agent is a conversation away. Open source, self-hostable,
            and ready to take work off your plate.
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Link to="/docs" className={btnPrimaryLg}>
              Read the docs
              <ArrowRight size={17} aria-hidden />
            </Link>
            <a href={GITHUB_URL} className={btnGhostLg}>
              <GithubGlyph size={17} />
              View on GitHub
            </a>
          </div>
        </GlassPanel>
      </Reveal>
    </section>
  );
}
