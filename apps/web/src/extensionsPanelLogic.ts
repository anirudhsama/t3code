import type {
  ProviderMcpOverrides,
  ProviderExtensionOverrideState,
  ProviderMcpServer,
  ProviderSkill,
  ThreadExtensionsSnapshot,
} from "@t3tools/contracts";

export type McpAuthUiState =
  | { readonly phase: "beginning" }
  | {
      readonly phase: "waiting";
      readonly authorizationUrl: string;
      readonly baselineError?: string;
      readonly pasteVisible: boolean;
      readonly openError?: string;
      readonly relayState?: "submitting" | "submitted";
      readonly relayError?: string;
    }
  | {
      readonly phase: "error";
      readonly message: string;
    };

export function createMcpAuthWaitingState(input: {
  readonly authorizationUrl: string;
  readonly localClient: boolean;
  readonly baselineError?: string;
}): Extract<McpAuthUiState, { readonly phase: "waiting" }> {
  return {
    phase: "waiting",
    authorizationUrl: input.authorizationUrl,
    pasteVisible: !input.localClient,
    ...(input.baselineError ? { baselineError: input.baselineError } : {}),
  };
}

export function applyDraftMcpOverrides(
  servers: readonly ProviderMcpServer[],
  overrides: ProviderMcpOverrides,
): ReadonlyArray<ProviderMcpServer> {
  return servers.map((server) => {
    const threadOverride = overrides[server.id] ?? "inherit";
    if (server.managed || !server.toggleable) return server;
    return {
      ...server,
      threadOverride,
      effectiveEnabled:
        threadOverride === "enabled" || (threadOverride === "inherit" && server.providerEnabled),
    };
  });
}

export function effectiveMcpOriginLabel(server: ProviderMcpServer): "Project" | "Global" {
  return server.origins.find((origin) => origin.effective)?.scope === "project"
    ? "Project"
    : "Global";
}

export function mcpStatusLabel(
  server: ProviderMcpServer,
  durable: boolean,
):
  | "Ready"
  | "Starting"
  | "Failed"
  | "Stopped"
  | "Disabled"
  | "Login required"
  | "Not started"
  | null {
  if (!server.statusObserved) return null;
  if (server.authStatus === "needs-auth") return "Login required";
  switch (server.startupStatus) {
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    case "disabled":
      return "Disabled";
    case "unknown":
      return server.statusObserved ? "Not started" : null;
  }
}

export function advanceMcpAuthState(
  state: McpAuthUiState,
  server: ProviderMcpServer,
): { readonly state: McpAuthUiState | null; readonly refresh: boolean } {
  if (state.phase !== "waiting") return { state, refresh: false };
  if (server.authStatus === "authenticated") return { state: null, refresh: true };
  if (server.error && server.error !== state.baselineError) {
    return {
      state: {
        phase: "error",
        message: server.error,
      },
      refresh: false,
    };
  }
  return { state, refresh: false };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.")
  );
}

export function isMcpAuthClientLocal(input: {
  readonly target:
    | { readonly _tag: "PrimaryConnectionTarget" }
    | { readonly _tag: "BearerConnectionTarget"; readonly connectionId: string }
    | { readonly _tag: "RelayConnectionTarget" | "SshConnectionTarget" };
  readonly electron: boolean;
  readonly hostname: string;
}): boolean {
  const localTarget =
    input.target._tag === "PrimaryConnectionTarget" ||
    (input.target._tag === "BearerConnectionTarget" &&
      input.target.connectionId.startsWith("local:"));
  return localTarget && (input.electron || isLoopbackHostname(input.hostname));
}

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

export type ExtensionRetryTarget = {
  kind: "mcp";
  id: ProviderMcpServer["id"];
  state: ProviderExtensionOverrideState;
};

export function extensionRetryTarget(
  snapshot: ThreadExtensionsSnapshot,
): ExtensionRetryTarget | null {
  const overriddenMcp = snapshot.mcpServers.find(
    (server) => server.toggleable && server.threadOverride !== "inherit",
  );
  if (overriddenMcp) {
    return { kind: "mcp", id: overriddenMcp.id, state: overriddenMcp.threadOverride };
  }
  const mcp = snapshot.mcpServers.find((server) => server.toggleable);
  return mcp ? { kind: "mcp", id: mcp.id, state: "inherit" } : null;
}

export function extensionPending(snapshot: ThreadExtensionsSnapshot): boolean {
  return snapshot.appliedOverrideRevision < snapshot.overrideRevision;
}
