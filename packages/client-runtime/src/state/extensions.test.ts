import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderExtensionItemId,
  ProviderInstanceId,
  ThreadId,
  type ThreadExtensionsSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createExtensionsEnvironmentAtoms,
  projectThreadExtensionsSnapshot,
  selectEffectiveThreadSkills,
  shouldAcceptThreadExtensionsSnapshot,
} from "./extensions.ts";

const snapshot = (input: {
  readonly inventoryRevision: number;
  readonly overrideRevision?: number;
  readonly appliedOverrideRevision?: number;
  readonly cwd?: string;
  readonly providerInstanceId?: string;
}): ThreadExtensionsSnapshot => ({
  threadId: ThreadId.make("thread-1"),
  providerInstanceId: ProviderInstanceId.make(input.providerInstanceId ?? "codex"),
  provider: ProviderDriverKind.make("codex"),
  cwd: input.cwd ?? "/repo",
  capabilities: {
    skills: { inventory: true, refresh: true, threadOverride: true },
    mcp: {
      inventory: true,
      liveStatus: true,
      threadOverride: true,
      reconnect: false,
      authenticate: true,
    },
  },
  skills: [],
  mcpServers: [],
  inventoryRevision: input.inventoryRevision,
  overrideRevision: input.overrideRevision ?? 0,
  appliedOverrideRevision: input.appliedOverrideRevision ?? 0,
  loading: { skills: false, mcp: false },
  errors: [],
  refreshedAt: "2026-01-01T00:00:00.000Z",
});

describe("thread extensions state", () => {
  it("discards late snapshots without merging contexts", () => {
    const current = snapshot({
      inventoryRevision: 5,
      overrideRevision: 3,
      appliedOverrideRevision: 3,
    });
    expect(
      shouldAcceptThreadExtensionsSnapshot(
        current,
        snapshot({ inventoryRevision: 4, overrideRevision: 3, appliedOverrideRevision: 3 }),
      ),
    ).toBe(false);
    expect(
      shouldAcceptThreadExtensionsSnapshot(
        current,
        snapshot({ inventoryRevision: 5, overrideRevision: 2, appliedOverrideRevision: 2 }),
      ),
    ).toBe(false);
    expect(
      shouldAcceptThreadExtensionsSnapshot(
        current,
        snapshot({ inventoryRevision: 1, cwd: "/other-repo" }),
      ),
    ).toBe(true);
    expect(
      shouldAcceptThreadExtensionsSnapshot(
        current,
        snapshot({ inventoryRevision: 1, providerInstanceId: "codex-work" }),
      ),
    ).toBe(true);
  });

  it("ignores synchronization markers and projects authoritative snapshots", () => {
    const initial = snapshot({ inventoryRevision: 1 });
    expect(projectThreadExtensionsSnapshot(null, { kind: "synchronized" })).toEqual([null, []]);
    expect(projectThreadExtensionsSnapshot(null, { kind: "snapshot", snapshot: initial })).toEqual([
      initial,
      [initial],
    ]);
  });

  it("selects only effectively enabled skills", () => {
    const enabled = {
      id: ProviderExtensionItemId.make("/repo/enabled/SKILL.md"),
      name: "enabled",
      scope: "project" as const,
      providerEnabled: true,
      threadOverride: "inherit" as const,
      effectiveEnabled: true,
    };
    const disabled = {
      ...enabled,
      id: ProviderExtensionItemId.make("/repo/disabled/SKILL.md"),
      effectiveEnabled: false,
    };
    expect(
      selectEffectiveThreadSkills({
        ...snapshot({ inventoryRevision: 1 }),
        skills: [enabled, disabled],
      }),
    ).toEqual([enabled]);
  });

  it("shares one subscription atom per environment and thread", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const extensions = createExtensionsEnvironmentAtoms(runtime);
    const target = {
      environmentId: EnvironmentId.make("environment-1"),
      input: { threadId: ThreadId.make("thread-1") },
    };
    expect(extensions.snapshot(target)).toBe(
      extensions.snapshot({
        environmentId: EnvironmentId.make("environment-1"),
        input: { threadId: ThreadId.make("thread-1") },
      }),
    );
    expect(extensions.snapshot(target)).not.toBe(
      extensions.snapshot({
        environmentId: EnvironmentId.make("environment-2"),
        input: { threadId: ThreadId.make("thread-1") },
      }),
    );
  });
});
