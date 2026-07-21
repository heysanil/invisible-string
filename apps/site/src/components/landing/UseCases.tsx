import { GlassPanel, StatusChip } from "../ui";
import { Reveal, SectionHeading } from "./parts";

/* "What would I hand off?" — work you could hand off this afternoon, each
   a trigger chip + a plain-language sketch of the standing work it handles.
   FeatureGrid's card DNA (glass panel, .lift, Reveal stagger); the icon square
   is swapped for a StatusChip trigger chip. No new animation machinery. */

const USE_CASES: ReadonlyArray<{
  chip: string;
  title: string;
  copy: string;
}> = [
  {
    chip: "Slack",
    title: "Issue triage",
    copy: "A GitHub issue lands — the agent reads it, checks the repo, replies in-thread, and labels it.",
  },
  {
    chip: "Schedule",
    title: "Monday digest",
    copy: "Every Monday at 9, your agent searches the week's activity and posts a summary where the team will see it.",
  },
  {
    chip: "Form",
    title: "Request intake",
    copy: "A shared form takes requests; the agent sorts and answers each one — and waits for your sign-off before anything big.",
  },
];

export function UseCases() {
  return (
    <section className="site-container section-block">
      <SectionHeading
        eyebrow="Use cases"
        title="What will you hand off first?"
        lede="Work you could hand off this afternoon — equip an agent once, then delegate."
      />
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {USE_CASES.map((u, i) => (
          <Reveal key={u.title} delay={(i % 3) * 0.06}>
            <GlassPanel className="lift flex h-full flex-col gap-3 p-5">
              <span className="w-fit">
                <StatusChip tone="ink">{u.chip}</StatusChip>
              </span>
              <h3 className="text-[14.5px] font-semibold text-ink">{u.title}</h3>
              <p className="text-[13px] leading-relaxed text-ink-3">{u.copy}</p>
            </GlassPanel>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
