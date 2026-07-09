import { Bot, FileText, Plug, Zap } from "lucide-react";
import type { ComponentType } from "react";

import { GlassPanel } from "../ui";
import { Reveal, SectionHeading } from "./parts";

const PILLARS: ReadonlyArray<{
  label: string;
  icon: ComponentType<{ size?: number }>;
  /** The app's real pillar-card one-liner (verbatim from the builder). */
  hint: string;
  copy: string;
}> = [
  {
    label: "Trigger",
    icon: Zap,
    hint: "How runs start",
    copy: "Chat, webhook, form, Slack, or a schedule.",
  },
  {
    label: "Context",
    icon: Plug,
    hint: "Tools and knowledge",
    copy: "The MCP connections and skills the agent can reach for.",
  },
  {
    label: "Agent",
    icon: Bot,
    hint: "Model and persona",
    copy: "Model presets — powerful, balanced, or quick.",
  },
  {
    label: "Instructions",
    icon: FileText,
    hint: "What the agent does",
    copy: "The prompt that drives the agent, with @refs into context.",
  },
];

export function Pillars() {
  return (
    <section className="site-container section-block">
      <SectionHeading
        eyebrow="The model"
        title="Four pillars. One workflow."
        lede="Every workflow is the same four decisions. Fill them in; the rest compiles."
      />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PILLARS.map((p, i) => {
          const Icon = p.icon;
          return (
            <Reveal key={p.label} delay={i * 0.07}>
              <GlassPanel className="lift flex h-full flex-col gap-3 p-5">
                <span className="flex size-9 items-center justify-center rounded-card bg-black/[0.05] text-ink">
                  <Icon size={18} />
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-[15px] font-semibold text-ink">{p.label}</h3>
                  <p className="text-[13px] font-medium text-ink-2">{p.hint}</p>
                </div>
                <p className="text-[13.5px] leading-relaxed text-ink-3">{p.copy}</p>
              </GlassPanel>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}
