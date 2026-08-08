import type {
  ModelSelection,
  ProviderExtensionCapabilities,
  ProviderExtensionItemId,
  ProviderMcpServer,
  ProviderMcpOverrides,
  ProviderSession,
  ProviderSkill,
  ProviderSkillOverrides,
  RuntimeMode,
  ThreadExtensionsMcpAuthResult,
  ThreadExtensionsRefreshDomain,
  ThreadExtensionsRpcError,
  ThreadExtensionsSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderAdapterError } from "../Errors.ts";

export interface ProviderExtensionRuntimeContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly runtimeMode?: RuntimeMode;
  readonly modelSelection?: ModelSelection;
  readonly resumeCursor?: unknown;
}

export interface ProviderExtensionInventoryInput extends ProviderExtensionRuntimeContext {
  readonly forceReload?: boolean;
}

export type ProviderSkillInventoryItem = Omit<ProviderSkill, "threadOverride" | "effectiveEnabled">;

export type ProviderMcpInventoryItem = Omit<
  ProviderMcpServer,
  "threadOverride" | "effectiveEnabled"
>;

export interface ProviderExtensionInventoryResult<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly revision: number;
  readonly warnings: ReadonlyArray<string>;
}

export type ProviderExtensionManagementEvent =
  | {
      readonly type: "inventory.invalidated";
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly domain: "skills" | "mcp";
    }
  | {
      readonly type: "inventory.updated";
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly domain: "skills" | "mcp";
      readonly revision: number;
    }
  | {
      readonly type: "mcp.status.changed";
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly mcpServerId: ProviderExtensionItemId;
      readonly revision: number;
    }
  | {
      readonly type: "overrides.reconciliation.changed";
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly state: ProviderExtensionReconciliationState;
    };

export interface ProviderExtensionReconciliationError {
  readonly domain: "all";
  readonly message: string;
  readonly retryable: true;
}

export interface ProviderExtensionReconciliationState {
  readonly appliedOverrideRevision: number;
  readonly pendingOverrideRevision?: number;
  readonly error?: ProviderExtensionReconciliationError;
}

export interface ProviderExtensionReconciliationInput extends ProviderExtensionRuntimeContext {
  readonly skillOverrides: ProviderSkillOverrides;
  readonly mcpOverrides: ProviderMcpOverrides;
  readonly extensionOverridesRevision: number;
  readonly defer?: boolean;
}

export interface ProviderExtensionReconciliationResult {
  readonly state: ProviderExtensionReconciliationState;
  readonly session?: ProviderSession;
}

export interface ProviderExtensionSkillsFacet {
  readonly inventory: (
    input: ProviderExtensionInventoryInput,
  ) => Effect.Effect<
    ProviderExtensionInventoryResult<ProviderSkillInventoryItem>,
    ProviderAdapterError
  >;
  readonly refresh: (
    input: ProviderExtensionRuntimeContext,
  ) => Effect.Effect<
    ProviderExtensionInventoryResult<ProviderSkillInventoryItem>,
    ProviderAdapterError
  >;
}

export interface ProviderExtensionMcpFacet {
  readonly inventory: (
    input: ProviderExtensionInventoryInput,
  ) => Effect.Effect<
    ProviderExtensionInventoryResult<ProviderMcpInventoryItem>,
    ProviderAdapterError
  >;
  readonly refresh: (
    input: ProviderExtensionRuntimeContext,
  ) => Effect.Effect<
    ProviderExtensionInventoryResult<ProviderMcpInventoryItem>,
    ProviderAdapterError
  >;
  readonly reconnect?: (
    input: ProviderExtensionRuntimeContext & { readonly mcpServerId: ProviderExtensionItemId },
  ) => Effect.Effect<void, ProviderAdapterError>;
  readonly authenticate?: (
    input: ProviderExtensionRuntimeContext & { readonly mcpServerId: ProviderExtensionItemId },
  ) => Effect.Effect<{ readonly authorizationUrl: string }, ProviderAdapterError>;
}

export interface ProviderExtensionsShape {
  readonly capabilities: ProviderExtensionCapabilities;
  readonly skills?: ProviderExtensionSkillsFacet;
  readonly mcp?: ProviderExtensionMcpFacet;
  readonly reconcileOverrides?: (
    input: ProviderExtensionReconciliationInput,
  ) => Effect.Effect<ProviderExtensionReconciliationResult, ProviderAdapterError>;
  readonly reconciliationState?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderExtensionReconciliationState>;
  readonly events: Stream.Stream<ProviderExtensionManagementEvent>;
}

export interface ThreadExtensionsShape {
  readonly snapshot: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ThreadExtensionsSnapshot, ThreadExtensionsRpcError>;
  readonly refresh: (input: {
    readonly threadId: ThreadId;
    readonly domain?: ThreadExtensionsRefreshDomain;
  }) => Effect.Effect<ThreadExtensionsSnapshot, ThreadExtensionsRpcError>;
  readonly events: (input: {
    readonly threadId: ThreadId;
  }) => Stream.Stream<ThreadExtensionsSnapshot, ThreadExtensionsRpcError>;
  readonly reconnectMcp?: (input: {
    readonly threadId: ThreadId;
    readonly mcpServerId: ProviderExtensionItemId;
  }) => Effect.Effect<ThreadExtensionsSnapshot, ThreadExtensionsRpcError>;
  readonly beginMcpAuth?: (input: {
    readonly threadId: ThreadId;
    readonly mcpServerId: ProviderExtensionItemId;
  }) => Effect.Effect<ThreadExtensionsMcpAuthResult, ThreadExtensionsRpcError>;
}

export class ThreadExtensions extends Context.Service<ThreadExtensions, ThreadExtensionsShape>()(
  "t3/provider/Services/ThreadExtensions",
) {}
