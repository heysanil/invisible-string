import { Bot, FileText, Plug, Zap } from "lucide-react";
import type { ComponentType } from "react";

import { GlassPanel } from "../ui";
import { Reveal, SectionHeading } from "./parts";

const PILLARS: ReadonlyArray<{
  label: string;
  icon: ComponentType<{ size?: number }>;
  /** The question this pillar answers for the user. */
  hint: string;
  copy: string;
}> = [
  {
    label: "Trigger",
    icon: Zap,
    hint: "What starts it",
    copy: "A chat message, a Slack mention, a form, a webhook, or a schedule.",
  },
  {
    label: "Context",
    icon: Plug,
    hint: "What it can use",
    copy: "The tools and knowledge it works with — GitHub, web search, your own skills.",
  },
  {
    label: "Agent",
    icon: Bot,
    hint: "How it thinks",
    copy: "Pick a preset: powerful for hard problems, balanced for most work, quick for the rest.",
  },
  {
    label: "Instructions",
    icon: FileText,
    hint: "What it should do",
    copy: "Plain-language instructions, with @refs into the trigger and your tools.",
  },
];

export function Pillars() {
  return (
    <section className="site-container section-block">
      <SectionHeading
        eyebrow="Describe it"
        title="Four decisions. One workflow."
        lede="Every workflow is the same four questions. Answer them — or just tell the copilot — and it's ready to run."
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
