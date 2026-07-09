import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";

import { Compile } from "../components/landing/Compile";
import { Copilot } from "../components/landing/Copilot";
import { Durability } from "../components/landing/Durability";
import { FeatureGrid } from "../components/landing/FeatureGrid";
import { FinalCTA } from "../components/landing/FinalCTA";
import { Hero } from "../components/landing/Hero";
import { Pillars } from "../components/landing/Pillars";
import { ThreadCanvas } from "../components/landing/ThreadCanvas";
import { Triggers } from "../components/landing/Triggers";

export const Route = createFileRoute("/")({ component: LandingPage });

/**
 * The landing page. A single tall, relatively-positioned column: the invisible
 * string (ThreadCanvas) is an absolute full-height layer behind the sections,
 * drawing itself down the page as you scroll; the sections sit on top at z-10.
 */
function LandingPage() {
  const pageRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={pageRef} className="relative overflow-x-clip">
      <ThreadCanvas targetRef={pageRef} />

      <div className="relative z-10">
        <Hero />
        <div id="product" className="scroll-mt-28">
          <Pillars />
        </div>
        <div id="how" className="scroll-mt-28">
          <Compile />
          <Durability />
          <Triggers />
          <Copilot />
        </div>
        <FeatureGrid />
        <FinalCTA />
      </div>
    </div>
  );
}
