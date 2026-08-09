import {
  ProviderDriverKind,
  ProviderExtensionItemId,
  ProviderInstanceId,
  ThreadId,
  type ThreadExtensionsSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceMcpAuthState,
  applyDraftMcpOverrides,
  createMcpAuthWaitingState,
  extensionPending,
  extensionRetryTarget,
  filterExtensionMcpServers,
  filterExtensionSkills,
  mcpStatusLabel,
  isMcpAuthClientLocal,
  sortExtensionMcpServers,
  sortExtensionSkills,
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
        statusObserved: true,
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

  it("sorts extension inventory by provenance and stable names", () => {
    const value = snapshot();
    const server = value.mcpServers[0]!;
    const skill = value.skills[0]!;
    expect(
      sortExtensionMcpServers([
        {
          ...server,
          id: ProviderExtensionItemId.make("runtime"),
          name: "runtime",
          origins: [{ scope: "system", label: "Runtime", effective: true }],
        },
        {
          ...server,
          id: ProviderExtensionItemId.make("user"),
          name: "user",
          origins: [{ scope: "user", label: "User", effective: true }],
        },
        {
          ...server,
          id: ProviderExtensionItemId.make("project-z"),
          name: "zeta",
          origins: [{ scope: "project", label: "Project", effective: true }],
        },
        {
          ...server,
          id: ProviderExtensionItemId.make("project-a"),
          name: "Alpha",
          origins: [{ scope: "project", label: "Project", effective: true }],
        },
      ]).map((item) => item.id),
    ).toEqual(["project-a", "project-z", "user", "runtime"]);
    expect(
      sortExtensionSkills([
        { ...skill, id: ProviderExtensionItemId.make("zeta"), name: "zeta" },
        { ...skill, id: ProviderExtensionItemId.make("alpha"), name: "Alpha" },
      ]).map((item) => item.id),
    ).toEqual(["alpha", "zeta"]);
  });

  it("derives pending and a semantics-preserving retry target from revisions", () => {
    const value = snapshot();
    expect(extensionPending(value)).toBe(true);
    expect(extensionRetryTarget(value)).toBeNull();
  });

  it("applies draft MCP intents without mutating the preview snapshot", () => {
    const source = {
      ...snapshot().mcpServers[0]!,
      id: ProviderExtensionItemId.make("docs"),
      name: "docs",
      managed: false,
      toggleable: true,
    };
    const [projected] = applyDraftMcpOverrides([source], {
      [ProviderExtensionItemId.make("docs")]: "disabled",
    });

    expect(projected).toMatchObject({ threadOverride: "disabled", effectiveEnabled: false });
    expect(source).toMatchObject({ threadOverride: "inherit", effectiveEnabled: true });
  });

  it("shows measured compose-time failures and keeps unmeasured drafts not started", () => {
    const server = {
      ...snapshot().mcpServers[0]!,
      startupStatus: "failed" as const,
      statusObserved: true,
    };
    expect(mcpStatusLabel(server, false)).toBe("Failed");
    expect(mcpStatusLabel({ ...server, startupStatus: "unknown" }, false)).toBe("Not started");
    expect(
      mcpStatusLabel({ ...server, startupStatus: "unknown", statusObserved: false }, false),
    ).toBeNull();
    expect(
      mcpStatusLabel({ ...server, startupStatus: "disabled", statusObserved: false }, true),
    ).toBeNull();
  });

  it("settles auth waiting state on completion and exposes timeout failures", () => {
    const server = snapshot().mcpServers[0]!;
    const waiting = {
      phase: "waiting" as const,
      authorizationUrl: "https://example.test/login",
      pasteVisible: true,
    };
    expect(advanceMcpAuthState(waiting, { ...server, authStatus: "authenticated" })).toEqual({
      state: null,
      refresh: true,
    });
    expect(
      advanceMcpAuthState(waiting, {
        ...server,
        authStatus: "needs-auth",
        error: "timed out waiting for OAuth callback",
      }),
    ).toEqual({
      state: {
        phase: "error",
        message: "timed out waiting for OAuth callback",
      },
      refresh: false,
    });
  });

  it("reveals paste-back immediately for remote clients and delays the local fallback", () => {
    expect(
      createMcpAuthWaitingState({
        authorizationUrl: "https://example.test/login",
        localClient: false,
      }).pasteVisible,
    ).toBe(true);
    expect(
      createMcpAuthWaitingState({
        authorizationUrl: "https://example.test/login",
        localClient: true,
      }).pasteVisible,
    ).toBe(false);
    expect(
      isMcpAuthClientLocal({
        target: { _tag: "PrimaryConnectionTarget" },
        electron: false,
        hostname: "127.0.0.1",
      }),
    ).toBe(true);
    expect(
      isMcpAuthClientLocal({
        target: { _tag: "RelayConnectionTarget" },
        electron: true,
        hostname: "localhost",
      }),
    ).toBe(false);
    expect(
      isMcpAuthClientLocal({
        target: { _tag: "PrimaryConnectionTarget" },
        electron: false,
        hostname: "app.t3.codes",
      }),
    ).toBe(false);
  });
});
