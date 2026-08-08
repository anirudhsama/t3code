import type {
  ProviderExtensionOverrideState,
  ProviderMcpServer,
  ProviderSkill,
  ThreadExtensionsSnapshot,
} from "@t3tools/contracts";

export const SKILL_GROUPS = [
  { id: "project", label: "Project", scopes: ["project"] },
  { id: "user", label: "Global & user", scopes: ["user"] },
  { id: "system", label: "System & admin", scopes: ["system", "admin"] },
  { id: "other", label: "Plugins & other", scopes: ["plugin", "unknown"] },
] as const;

export function filterExtensionSkills(skills: readonly ProviderSkill[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return skills;
  return skills.filter((skill) =>
    [
      skill.name,
      skill.displayName,
      skill.description,
      skill.scope,
      skill.path,
      skill.origin?.label,
      skill.origin?.path,
    ].some((value) => value?.toLowerCase().includes(normalized)),
  );
}

export function filterExtensionMcpServers(servers: readonly ProviderMcpServer[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return servers;
  return servers.filter((server) =>
    [
      server.name,
      server.id,
      server.error,
      ...server.origins.flatMap((origin) => [origin.label, origin.path]),
    ]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalized)),
  );
}

export type ExtensionRetryTarget =
  | { kind: "skill"; id: ProviderSkill["id"]; state: ProviderExtensionOverrideState }
  | { kind: "mcp"; id: ProviderMcpServer["id"]; state: ProviderExtensionOverrideState };

export function extensionRetryTarget(
  snapshot: ThreadExtensionsSnapshot,
): ExtensionRetryTarget | null {
  const overriddenSkill = snapshot.skills.find((skill) => skill.threadOverride !== "inherit");
  if (overriddenSkill) {
    return { kind: "skill", id: overriddenSkill.id, state: overriddenSkill.threadOverride };
  }
  const overriddenMcp = snapshot.mcpServers.find(
    (server) => server.toggleable && server.threadOverride !== "inherit",
  );
  if (overriddenMcp) {
    return { kind: "mcp", id: overriddenMcp.id, state: overriddenMcp.threadOverride };
  }
  const skill = snapshot.skills[0];
  if (skill) return { kind: "skill", id: skill.id, state: "inherit" };
  const mcp = snapshot.mcpServers.find((server) => server.toggleable);
  return mcp ? { kind: "mcp", id: mcp.id, state: "inherit" } : null;
}

export function extensionPending(snapshot: ThreadExtensionsSnapshot): boolean {
  return snapshot.appliedOverrideRevision < snapshot.overrideRevision;
}
