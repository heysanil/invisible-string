import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";

import { Agents } from "../components/landing/Agents";
import { Copilot } from "../components/landing/Copilot";
import { Durability } from "../components/landing/Durability";
import { FeatureGrid } from "../components/landing/FeatureGrid";
import { FinalCTA } from "../components/landing/FinalCTA";
import { Hero } from "../components/landing/Hero";
import { ThreadCanvas } from "../components/landing/ThreadCanvas";
import { Triggers } from "../components/landing/Triggers";
import { UseCases } from "../components/landing/UseCases";

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
          <UseCases />
        </div>
        <div id="how" className="scroll-mt-28">
          <Agents />
          <Copilot />
          <Triggers />
          <Durability />
        </div>
        <FeatureGrid />
        <FinalCTA />
      </div>
    </div>
  );
}
