/**
 * Merged CONTEXT resources for the builder. MCP connections and skills exist
 * at BOTH workspace and user scope (spec §9); the context pillar attaches by
 * id across both, so the builder needs one flat list per kind tagged with its
 * scope.
 */
import { useMemo } from "react";
import type {
  McpConnectionDto,
  SkillDto,
} from "@invisible-string/shared";

import { useMcpConnections } from "../queries/mcp-connections";
import { useSkills } from "../queries/skills";
import type { ScopeRef } from "../queries/keys";

export type ResourceScope = "workspace" | "user";

export interface ScopedConnection extends McpConnectionDto {
  resourceScope: ResourceScope;
}

export interface ScopedSkill extends SkillDto {
  resourceScope: ResourceScope;
}

export interface ContextResources {
  connections: ScopedConnection[];
  skills: ScopedSkill[];
  connectionById: Map<string, ScopedConnection>;
  skillById: Map<string, ScopedSkill>;
  isPending: boolean;
  isError: boolean;
}

export function useContextResources(workspaceId: string): ContextResources {
  const workspaceRef: ScopeRef = { scope: "workspace", workspaceId };
  const userRef: ScopeRef = { scope: "user" };

  const wsConnections = useMcpConnections(workspaceRef);
  const userConnections = useMcpConnections(userRef);
  const wsSkills = useSkills(workspaceRef);
  const userSkills = useSkills(userRef);

  return useMemo(() => {
    const connections: ScopedConnection[] = [
      ...(wsConnections.data ?? []).map((c) => ({
        ...c,
        resourceScope: "workspace" as const,
      })),
      ...(userConnections.data ?? []).map((c) => ({
        ...c,
        resourceScope: "user" as const,
      })),
    ];
    const skills: ScopedSkill[] = [
      ...(wsSkills.data ?? []).map((s) => ({
        ...s,
        resourceScope: "workspace" as const,
      })),
      ...(userSkills.data ?? []).map((s) => ({
        ...s,
        resourceScope: "user" as const,
      })),
    ];
    return {
      connections,
      skills,
      connectionById: new Map(connections.map((c) => [c.id, c])),
      skillById: new Map(skills.map((s) => [s.id, s])),
      isPending:
        wsConnections.isPending ||
        userConnections.isPending ||
        wsSkills.isPending ||
        userSkills.isPending,
      isError:
        wsConnections.isError ||
        userConnections.isError ||
        wsSkills.isError ||
        userSkills.isError,
    };
  }, [
    wsConnections.data,
    userConnections.data,
    wsSkills.data,
    userSkills.data,
    wsConnections.isPending,
    userConnections.isPending,
    wsSkills.isPending,
    userSkills.isPending,
    wsConnections.isError,
    userConnections.isError,
    wsSkills.isError,
    userSkills.isError,
  ]);
}

/** The ScopeRef a scoped resource lives under (for mutations). */
export function scopeRefOf(
  resourceScope: ResourceScope,
  workspaceId: string,
): ScopeRef {
  return resourceScope === "user"
    ? { scope: "user" }
    : { scope: "workspace", workspaceId };
}
