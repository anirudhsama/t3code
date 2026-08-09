import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderExtensionItemId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type ThreadExtensionsSnapshot,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { ExtensionsPanel } from "./ExtensionsPanel";
import { useRightPanelStore } from "../rightPanelStore";

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
        statusObserved: true,
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

function render(
  snapshotValue: ThreadExtensionsSnapshot,
  options?: { activeTurn?: boolean; durable?: boolean; skillsCollapsed?: boolean },
): string {
  const ref = scopeThreadRef(environmentId, threadId);
  useRightPanelStore.setState({
    byThreadKey: {
      [scopedThreadKey(ref)]: {
        isOpen: true,
        activeSurfaceId: "extensions",
        surfaces: [{ id: "extensions", kind: "extensions" }],
        extensionsSkillsCollapsed: options?.skillsCollapsed ?? true,
      },
    },
  });
  return renderToStaticMarkup(
    <ExtensionsPanel
      environmentId={environmentId}
      threadId={threadId}
      snapshot={snapshotValue}
      loadError={null}
      isLoading={false}
      projectId={null}
      providerInstanceId={null}
      durable={options?.durable ?? true}
      activeTurn={options?.activeTurn ?? false}
      draftMcpOverrides={{}}
      canOpenAuthLocally={false}
      {...(options?.skillsCollapsed === undefined
        ? {}
        : { skillsCollapsed: options.skillsCollapsed })}
      onSetDraftMcpOverride={() => {}}
    />,
  );
}

describe("ExtensionsPanel", () => {
  it("puts MCP first and keeps inventory-only skills collapsed by default", () => {
    const markup = render(snapshot());

    expect(markup).toContain("codex-work");
    expect(markup).toContain("/repo");
    expect(markup).not.toContain("Review this repository");
    expect(markup.indexOf('id="extensions-mcp-heading"')).toBeLessThan(
      markup.indexOf('id="extensions-skills-heading"'),
    );
    expect(markup).toContain("Managed by T3 Code and required for runtime coordination");
    expect(markup).toContain("MCP changes control future availability");
    expect(markup).not.toContain("Provider default:");
    expect(markup).not.toContain("Thread: Inherit");
  });

  it("renders skill provenance without override controls when expanded", () => {
    const markup = render(snapshot(), { skillsCollapsed: false });
    expect(markup).toContain("Review this repository");
    expect(markup).not.toContain("Disable review for this thread");
    expect(markup).not.toContain("Provider default:");
  });

  it("explains unsupported inventory without hiding either section", () => {
    const value = snapshot();
    const markup = render(
      {
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
      },
      { skillsCollapsed: false },
    );

    expect(markup).toContain("does not expose contextual skill inventory yet");
    expect(markup).toContain("does not expose MCP inventory or thread-local enablement yet");
  });

  it("ties pending copy to desired and applied revisions during a turn", () => {
    const value = snapshot();
    const markup = render({ ...value, appliedOverrideRevision: 1 }, { activeTurn: true });

    expect(markup).toContain("saved and pending until the current turn completes");
  });

  it("omits status and count placeholders until live status is observed", () => {
    const value = snapshot();
    const markup = render({
      ...value,
      mcpServers: [
        {
          ...value.mcpServers[0]!,
          startupStatus: "unknown",
          authStatus: "unknown",
          statusObserved: false,
        },
      ],
    });
    expect(markup).not.toContain("status unknown");
    expect(markup).not.toContain("0 resources");
    expect(markup).toContain("Status appears once discovery runs or the session starts");
  });

  it("shows draft MCP intent without the old read-only banner", () => {
    const value = snapshot();
    const markup = renderToStaticMarkup(
      <ExtensionsPanel
        environmentId={environmentId}
        threadId={threadId}
        projectId={ProjectId.make("project-1")}
        providerInstanceId={value.providerInstanceId}
        snapshot={{
          ...value,
          overrideRevision: 0,
          appliedOverrideRevision: 0,
          mcpServers: [
            {
              ...value.mcpServers[0]!,
              id: ProviderExtensionItemId.make("docs"),
              name: "docs",
              managed: false,
              toggleable: true,
            },
          ],
        }}
        loadError={null}
        isLoading={false}
        durable={false}
        activeTurn={false}
        draftMcpOverrides={{ [ProviderExtensionItemId.make("docs")]: "disabled" }}
        canOpenAuthLocally={false}
        skillsCollapsed
        onSetDraftMcpOverride={() => {}}
      />,
    );
    expect(markup).not.toContain("Send the first message");
    expect(markup).toContain("Will apply when this thread is created");
  });
});
