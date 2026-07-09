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
    title: "Workspaces & SSO",
    copy: "Multi-tenant from day one — organizations, roles, and OIDC single sign-on.",
    icon: Users,
  },
  {
    title: "Encrypted secrets",
    copy: "Credentials sealed with AES-256-GCM envelope encryption, bound to the tenant.",
    icon: ShieldCheck,
  },
  {
    title: "Version pinning",
    copy: "A session keeps the exact compiled agent it started on. Publishing never breaks a live run.",
    icon: GitBranch,
  },
  {
    title: "Human-in-the-loop",
    copy: "Approvals park a run durably and resume it the moment someone signs off.",
    icon: UserCheck,
  },
  {
    title: "Model presets",
    copy: "Powerful, balanced, or quick — with an allowlist that constrains what agents can route to.",
    icon: SlidersHorizontal,
  },
  {
    title: "Self-hostable",
    copy: "The whole platform runs on one compose stack. Your keys, your infrastructure.",
    icon: Server,
  },
];

export function FeatureGrid() {
  return (
    <section className="site-container section-block">
      <SectionHeading
        eyebrow="Platform"
        title="Built like production software."
        lede="The unglamorous guarantees that make an agent platform trustworthy."
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
    </section>
  );
}
