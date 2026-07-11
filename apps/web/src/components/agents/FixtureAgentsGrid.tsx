/**
 * Fixture-mode /agents grid (VITE_FIXTURE_MODE=1): the production card grid
 * over the canned four-agent state matrix — no queries, no backend. "New
 * agent" is inert here (creation needs a control plane).
 */
import { Plus } from "lucide-react";

import { FIXTURE_AGENTS } from "../../lib/agents/fixtures";
import { Button } from "../ui/Button";
import { AgentCardGrid, AgentsGridShell } from "./AgentsGrid";

export function FixtureAgentsGrid() {
  return (
    <AgentsGridShell
      action={
        <Button
          variant="primary"
          size="sm"
          title="Creating agents needs a backend — fixture mode is display-only."
        >
          <Plus size={14} aria-hidden="true" />
          New agent
        </Button>
      }
    >
      <AgentCardGrid agents={FIXTURE_AGENTS.map((entry) => entry.summary)} />
    </AgentsGridShell>
  );
}
