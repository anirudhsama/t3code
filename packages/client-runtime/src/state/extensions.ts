import {
  EXTENSIONS_WS_METHODS,
  type ThreadExtensionsSnapshot,
  type ThreadExtensionsStreamItem,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function shouldAcceptThreadExtensionsSnapshot(
  current: ThreadExtensionsSnapshot | null,
  next: ThreadExtensionsSnapshot,
): boolean {
  if (current === null) return true;
  if (
    current.threadId !== next.threadId ||
    current.providerInstanceId !== next.providerInstanceId ||
    current.provider !== next.provider ||
    current.cwd !== next.cwd
  ) {
    return true;
  }
  if (
    next.inventoryRevision < current.inventoryRevision ||
    next.overrideRevision < current.overrideRevision
  ) {
    return false;
  }
  return !(
    next.inventoryRevision === current.inventoryRevision &&
    next.overrideRevision === current.overrideRevision &&
    next.appliedOverrideRevision < current.appliedOverrideRevision
  );
}

export function projectThreadExtensionsSnapshot(
  current: ThreadExtensionsSnapshot | null,
  event: ThreadExtensionsStreamItem,
): readonly [ThreadExtensionsSnapshot | null, ReadonlyArray<ThreadExtensionsSnapshot>] {
  if (event.kind === "synchronized") return [current, []];
  if (!shouldAcceptThreadExtensionsSnapshot(current, event.snapshot)) return [current, []];
  return [event.snapshot, [event.snapshot]];
}

export function selectEffectiveThreadSkills(snapshot: ThreadExtensionsSnapshot | null) {
  return snapshot?.skills.filter((skill) => skill.effectiveEnabled) ?? [];
}

export function createExtensionsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const actionScheduler = createAtomCommandScheduler();
  const actionConcurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly threadId: string };
    }) => JSON.stringify([environmentId, input.threadId]),
  };

  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:extensions:thread-snapshot",
      tag: EXTENSIONS_WS_METHODS.subscribeThread,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(
            () => null as ThreadExtensionsSnapshot | null,
            projectThreadExtensionsSnapshot,
          ),
        ),
    }),
    previewSnapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:extensions:preview-snapshot",
      tag: EXTENSIONS_WS_METHODS.subscribePreview,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(
            () => null as ThreadExtensionsSnapshot | null,
            projectThreadExtensionsSnapshot,
          ),
        ),
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:extensions:refresh",
      tag: EXTENSIONS_WS_METHODS.refreshThread,
      scheduler: actionScheduler,
      concurrency: actionConcurrency,
    }),
    refreshPreview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:extensions:refresh-preview",
      tag: EXTENSIONS_WS_METHODS.refreshPreview,
      scheduler: actionScheduler,
      concurrency: actionConcurrency,
    }),
    reconnectMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:extensions:reconnect-mcp",
      tag: EXTENSIONS_WS_METHODS.reconnectMcp,
      scheduler: actionScheduler,
      concurrency: actionConcurrency,
    }),
    beginMcpAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:extensions:begin-mcp-auth",
      tag: EXTENSIONS_WS_METHODS.beginMcpAuth,
      scheduler: actionScheduler,
      concurrency: actionConcurrency,
    }),
  };
}
