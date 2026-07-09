import { Link } from "@tanstack/react-router";
import {
  GitBranch,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
  Users,
} from "lucide-react";
import type { ComponentType } from "react";

import { GlassPanel } from "../ui";
import { Reveal, SectionHeading } from "./parts";

const FEATURES: ReadonlyArray<{
  title: string;
  copy: string;
  icon: ComponentType<{ size?: number }>;
}> = [
  {
    title: "Your team, with roles",
    copy: "Share a workspace with your team — roles decide who can build, run, and administer, with single sign-on if you use it.",
    icon: Users,
  },
  {
    title: "Private credentials",
    copy: "The accounts and keys your workflows use are encrypted at rest and never shown again — not in logs, not to the model.",
    icon: ShieldCheck,
  },
  {
    title: "No surprise changes",
    copy: "A running session keeps the exact version of the workflow it started with. Publishing an update never breaks a run in flight.",
    icon: GitBranch,
  },
  {
    title: "You approve the big steps",
    copy: "A workflow can pause and wait — for hours if it has to — until someone signs off, then pick up right where it stopped.",
    icon: UserCheck,
  },
  {
    title: "Your models, your rules",
    copy: "Powerful, balanced, or quick per workflow — chosen from the models your workspace has approved.",
    icon: SlidersHorizontal,
  },
  {
    title: "Runs on your machines",
    copy: "Open source and self-hostable. Your keys and your data stay on infrastructure you control.",
    icon: Server,
  },
];

export function FeatureGrid() {
  return (
    <section className="site-container section-block">
      <SectionHeading
        eyebrow="Control"
        title="You stay in control."
        lede="The quiet guarantees that make it safe to hand real work to an agent."
      />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => {
          const Icon = f.icon;
          return (
            <Reveal key={f.title} delay={(i % 3) * 0.06}>
              <GlassPanel className="lift flex h-full flex-col gap-3 p-5">
                <span className="flex size-9 items-center justify-center rounded-card bg-black/[0.05] text-ink">
                  <Icon size={18} />
                </span>
                <h3 className="text-[14.5px] font-semibold text-ink">{f.title}</h3>
                <p className="text-[13px] leading-relaxed text-ink-3">{f.copy}</p>
              </GlassPanel>
            </Reveal>
          );
        })}
      </div>

      {/* Under-the-hood pointer: the single sanctioned trace of the infra story,
          handing the curious reader off to the architecture docs. */}
      <Reveal className="mt-8 flex justify-center">
        <p className="glass-panel rounded-capsule flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1 px-5 py-2.5 text-center text-[13px] text-ink-3">
          <span>
            Under the hood: every workflow compiles into its own versioned agent
            on a durable worker pool.
          </span>
          <Link
            to="/docs/$"
            params={{ _splat: "platform/architecture" }}
            className="lift font-medium text-ink-2 hover:text-ink"
          >
            Read the architecture →
          </Link>
        </p>
      </Reveal>
    </section>
  );
}
