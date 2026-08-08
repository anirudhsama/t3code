import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderExtensionItemId,
  ProviderInstanceId,
  ThreadId,
  type ThreadExtensionsSnapshot,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ExtensionsPanel } from "./ExtensionsPanel";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");

function snapshot(): ThreadExtensionsSnapshot {
  return {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex-work"),
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
        id: ProviderExtensionItemId.make("/repo/.agents/skills/review/SKILL.md"),
        name: "review",
        description: "Review this repository",
        scope: "project",
        path: "/repo/.agents/skills/review/SKILL.md",
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
    inventoryRevision: 1,
    overrideRevision: 2,
    appliedOverrideRevision: 2,
    loading: { skills: false, mcp: false },
    errors: [],
    refreshedAt: "2026-08-09T00:00:00.000Z",
  };
}

function render(snapshotValue: ThreadExtensionsSnapshot, activeTurn = false): string {
  return renderToStaticMarkup(
    <ExtensionsPanel
      environmentId={environmentId}
      threadId={threadId}
      snapshot={snapshotValue}
      loadError={null}
      isLoading={false}
      durable
      activeTurn={activeTurn}
    />,
  );
}

describe("ExtensionsPanel", () => {
  it("keeps disabled skills and the locked managed MCP server visible", () => {
    const markup = render(snapshot());

    expect(markup).toContain("codex-work");
    expect(markup).toContain("/repo");
    expect(markup).toContain("review");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Managed by T3 Code and required for runtime coordination");
    expect(markup).toContain("controls future availability");
    expect(markup).toContain("does not erase skill instructions or MCP history");
  });

  it("explains unsupported inventory without hiding either section", () => {
    const value = snapshot();
    const markup = render({
      ...value,
      capabilities: {
        skills: { inventory: false, refresh: false, threadOverride: false },
        mcp: {
          inventory: false,
          liveStatus: false,
          threadOverride: false,
          reconnect: false,
          authenticate: false,
        },
      },
      skills: [],
      mcpServers: [],
    });

    expect(markup).toContain("does not expose contextual skill inventory yet");
    expect(markup).toContain("does not expose MCP inventory or thread-local enablement yet");
  });

  it("ties pending copy to desired and applied revisions during a turn", () => {
    const value = snapshot();
    const markup = render({ ...value, appliedOverrideRevision: 1 }, true);

    expect(markup).toContain("saved and pending until the current turn completes");
    expect(markup).toContain("Pending until the current turn completes");
  });
});
