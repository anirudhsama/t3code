import {
  ProviderDriverKind,
  ProviderExtensionItemId,
  ProviderInstanceId,
  ThreadId,
  type ThreadExtensionsSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  extensionPending,
  extensionRetryTarget,
  filterExtensionMcpServers,
  filterExtensionSkills,
} from "./extensionsPanelLogic";

function snapshot(): ThreadExtensionsSnapshot {
  return {
    threadId: ThreadId.make("thread-1"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    provider: ProviderDriverKind.make("codex"),
    cwd: "/repo",
    capabilities: {
      skills: { inventory: true, refresh: true, threadOverride: true },
      mcp: {
        inventory: true,
        liveStatus: true,
        threadOverride: true,
        reconnect: true,
        authenticate: true,
      },
    },
    skills: [
      {
        id: ProviderExtensionItemId.make("/repo/disabled/SKILL.md"),
        name: "disabled-review",
        description: "Still manageable",
        scope: "project",
        path: "/repo/disabled/SKILL.md",
        providerEnabled: true,
        threadOverride: "disabled",
        effectiveEnabled: false,
      },
    ],
    mcpServers: [
      {
        id: ProviderExtensionItemId.make("t3-code"),
        name: "t3-code",
        origins: [{ scope: "system", label: "T3 runtime", effective: true }],
        providerEnabled: true,
        threadOverride: "inherit",
        effectiveEnabled: true,
        managed: true,
        toggleable: false,
        startupStatus: "ready",
        authStatus: "not-required",
        toolCount: 3,
        resourceCount: 0,
        resourceTemplateCount: 0,
      },
    ],
    inventoryRevision: 3,
    overrideRevision: 2,
    appliedOverrideRevision: 1,
    loading: { skills: false, mcp: false },
    errors: [],
    refreshedAt: "2026-08-09T12:00:00.000Z",
  };
}

describe("extensions panel logic", () => {
  it("keeps disabled skills visible and searchable", () => {
    const value = snapshot();
    expect(filterExtensionSkills(value.skills, "manageable")).toEqual(value.skills);
  });

  it("finds managed MCP rows by provenance without hiding them", () => {
    const value = snapshot();
    expect(filterExtensionMcpServers(value.mcpServers, "runtime")).toEqual(value.mcpServers);
  });

  it("derives pending and a semantics-preserving retry target from revisions", () => {
    const value = snapshot();
    expect(extensionPending(value)).toBe(true);
    expect(extensionRetryTarget(value)).toEqual({
      kind: "skill",
      id: value.skills[0]!.id,
      state: "disabled",
    });
  });
});
