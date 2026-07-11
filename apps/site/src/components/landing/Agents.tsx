import { ArrowRight, Bot, FileText, Gauge, Plug, UserRound, Zap } from "lucide-react";
import type { ComponentType } from "react";

import { GlassPanel } from "../ui";
import { Reveal, SectionHeading } from "./parts";

/* "Hire the agent. Delegate the work." An Agent is someone you hire — three
   cards spell out its definition (Persona · Model · Context) — and a Workflow
   is a standing delegation, drawn as a full-width trigger → agent →
   instructions strip beneath them. */

const FACETS: ReadonlyArray<{
  label: string;
  icon: ComponentType<{ size?: number }>;
  /** The question this facet answers for the user. */
  hint: string;
  copy: string;
}> = [
  {
    label: "Persona",
    icon: UserRound,
    hint: "Who it is",
    copy: "A role and a way of working, in plain language — “pragmatic senior engineer, reads before it writes.”",
  },
  {
    label: "Model",
    icon: Gauge,
    hint: "How it thinks",
    copy: "Powerful for hard problems, balanced for everyday work, quick for the rest — from the models your workspace allows.",
  },
  {
    label: "Context",
    icon: Plug,
    hint: "What it's equipped with",
    copy: "The connections and skills it works with — GitHub, web search, your own tools.",
  },
];

const DELEGATION: ReadonlyArray<{
  label: string;
  icon: ComponentType<{ size?: number }>;
  hint: string;
  copy: string;
}> = [
  {
    label: "Trigger",
    icon: Zap,
    hint: "When it happens",
    copy: "A Slack mention, a form, a webhook, or a schedule.",
  },
  {
    label: "Agent",
    icon: Bot,
    hint: "Who handles it",
    copy: "One of the agents you've hired and published.",
  },
  {
    label: "Instructions",
    icon: FileText,
    hint: "What to do",
    copy: "Plain language, with @refs into the trigger.",
  },
];

export function Agents() {
  return (
    <section className="site-container section-block">
      <SectionHeading
        eyebrow="Hire it"
        title="Hire the agent. Delegate the work."
        lede="An agent is someone you hire — give it a persona, a model, and the tools it's equipped with. Publish it once: chat with it directly, or put it on standing duty."
      />

      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {FACETS.map((f, i) => {
          const Icon = f.icon;
          return (
            <Reveal key={f.label} delay={i * 0.07}>
              <GlassPanel className="lift flex h-full flex-col gap-3 p-5">
                <span className="flex size-9 items-center justify-center rounded-card bg-black/[0.05] text-ink">
                  <Icon size={18} />
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-[15px] font-semibold text-ink">{f.label}</h3>
                  <p className="text-[13px] font-medium text-ink-2">{f.hint}</p>
                </div>
                <p className="text-[13.5px] leading-relaxed text-ink-3">{f.copy}</p>
              </GlassPanel>
            </Reveal>
          );
        })}
      </div>

      {/* The delegation strip: a workflow is trigger → agent → instructions. */}
      <Reveal delay={0.2} className="mt-4">
        <GlassPanel className="flex flex-col gap-4 p-5 sm:p-6">
          <div className="grid items-stretch gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:gap-3">
            {DELEGATION.map((d, i) => {
              const Icon = d.icon;
              return [
                i > 0 ? (
                  <ArrowRight
                    key={`arrow-${d.label}`}
                    size={16}
                    aria-hidden
                    className="mx-auto rotate-90 self-center text-ink-4 md:rotate-0"
                  />
                ) : null,
                <div
                  key={d.label}
                  className="flex flex-col gap-1.5 rounded-card border border-black/[0.07] bg-white/45 p-4"
                >
                  <span className="flex items-center gap-2">
                    <Icon size={15} aria-hidden />
                    <span className="text-[13.5px] font-semibold text-ink">
                      {d.label}
                    </span>
                  </span>
                  <span className="text-[12.5px] font-medium text-ink-2">{d.hint}</span>
                  <span className="text-[12.5px] leading-snug text-ink-3">{d.copy}</span>
                </div>,
              ];
            })}
          </div>
          <p className="border-t border-hairline pt-4 text-center text-[13px] leading-relaxed text-ink-3">
            A workflow is a standing instruction — “watch these Slack messages
            and prepare a report.” Publish it instantly; when it fires, your
            agent gets the instructions and gets to work.
          </p>
        </GlassPanel>
      </Reveal>
    </section>
  );
}
