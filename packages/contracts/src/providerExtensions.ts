import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderExtensionItemId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderExtensionItemId"),
);
export type ProviderExtensionItemId = typeof ProviderExtensionItemId.Type;

export const ProviderExtensionOverrideState = Schema.Literals(["inherit", "enabled", "disabled"]);
export type ProviderExtensionOverrideState = typeof ProviderExtensionOverrideState.Type;

export const ProviderExtensionStoredOverrideState = Schema.Literals(["enabled", "disabled"]);
export type ProviderExtensionStoredOverrideState = typeof ProviderExtensionStoredOverrideState.Type;

export const ProviderSkillOverrides = Schema.Record(
  ProviderExtensionItemId,
  ProviderExtensionStoredOverrideState,
);
export type ProviderSkillOverrides = typeof ProviderSkillOverrides.Type;

export const ProviderMcpOverrides = Schema.Record(
  ProviderExtensionItemId,
  ProviderExtensionStoredOverrideState,
);
export type ProviderMcpOverrides = typeof ProviderMcpOverrides.Type;

export const ProviderThreadExtensionOverrides = Schema.Struct({
  skills: ProviderSkillOverrides,
  mcp: ProviderMcpOverrides,
  revision: NonNegativeInt,
});
export type ProviderThreadExtensionOverrides = typeof ProviderThreadExtensionOverrides.Type;

export const ProviderSelectedSkill = Schema.Struct({
  id: ProviderExtensionItemId,
  name: TrimmedNonEmptyString,
  path: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSelectedSkill = typeof ProviderSelectedSkill.Type;

export const ProviderExtensionScope = Schema.Literals([
  "project",
  "user",
  "system",
  "admin",
  "plugin",
  "unknown",
]);
export type ProviderExtensionScope = typeof ProviderExtensionScope.Type;

export const ProviderExtensionOrigin = Schema.Struct({
  scope: ProviderExtensionScope,
  label: Schema.optional(TrimmedNonEmptyString),
  path: Schema.optional(TrimmedNonEmptyString),
  effective: Schema.Boolean,
  metadata: Schema.optional(Schema.Unknown),
});
export type ProviderExtensionOrigin = typeof ProviderExtensionOrigin.Type;

export const ProviderSkill = Schema.Struct({
  id: ProviderExtensionItemId,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  scope: ProviderExtensionScope,
  path: Schema.optional(TrimmedNonEmptyString),
  providerEnabled: Schema.Boolean,
  threadOverride: ProviderExtensionOverrideState,
  effectiveEnabled: Schema.Boolean,
  shadowedBy: Schema.optional(ProviderExtensionItemId),
  precedence: Schema.optional(NonNegativeInt),
  origin: Schema.optional(ProviderExtensionOrigin),
});
export type ProviderSkill = typeof ProviderSkill.Type;

export const ProviderMcpStartupStatus = Schema.Literals([
  "unknown",
  "starting",
  "ready",
  "failed",
  "cancelled",
  "disabled",
]);
export type ProviderMcpStartupStatus = typeof ProviderMcpStartupStatus.Type;

export const ProviderMcpAuthStatus = Schema.Literals([
  "unknown",
  "not-required",
  "authenticated",
  "needs-auth",
  "unsupported",
]);
export type ProviderMcpAuthStatus = typeof ProviderMcpAuthStatus.Type;

export const ProviderMcpServer = Schema.Struct({
  id: ProviderExtensionItemId,
  name: TrimmedNonEmptyString,
  origins: Schema.Array(ProviderExtensionOrigin),
  providerEnabled: Schema.Boolean,
  threadOverride: ProviderExtensionOverrideState,
  effectiveEnabled: Schema.Boolean,
  managed: Schema.Boolean,
  toggleable: Schema.Boolean,
  startupStatus: ProviderMcpStartupStatus,
  authStatus: ProviderMcpAuthStatus,
  statusObserved: Schema.Boolean,
  error: Schema.optional(TrimmedNonEmptyString),
  serverInfo: Schema.optional(Schema.Unknown),
  toolCount: Schema.optional(NonNegativeInt),
  resourceCount: Schema.optional(NonNegativeInt),
  resourceTemplateCount: Schema.optional(NonNegativeInt),
});
export type ProviderMcpServer = typeof ProviderMcpServer.Type;

export const ProviderExtensionCapabilities = Schema.Struct({
  skills: Schema.Struct({
    inventory: Schema.Boolean,
    refresh: Schema.Boolean,
    threadOverride: Schema.Boolean,
  }),
  mcp: Schema.Struct({
    inventory: Schema.Boolean,
    liveStatus: Schema.Boolean,
    threadOverride: Schema.Boolean,
    reconnect: Schema.Boolean,
    authenticate: Schema.Boolean,
  }),
});
export type ProviderExtensionCapabilities = typeof ProviderExtensionCapabilities.Type;

export const ThreadExtensionsSnapshotError = Schema.Struct({
  domain: Schema.Literals(["skills", "mcp", "all"]),
  message: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
});
export type ThreadExtensionsSnapshotError = typeof ThreadExtensionsSnapshotError.Type;

export const ThreadExtensionsSnapshot = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  cwd: TrimmedNonEmptyString,
  capabilities: ProviderExtensionCapabilities,
  skills: Schema.Array(ProviderSkill),
  mcpServers: Schema.Array(ProviderMcpServer),
  inventoryRevision: NonNegativeInt,
  overrideRevision: NonNegativeInt,
  appliedOverrideRevision: NonNegativeInt,
  loading: Schema.Struct({
    skills: Schema.Boolean,
    mcp: Schema.Boolean,
  }),
  errors: Schema.Array(ThreadExtensionsSnapshotError),
  refreshedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadExtensionsSnapshot = typeof ThreadExtensionsSnapshot.Type;

export const ThreadExtensionsRefreshDomain = Schema.Literals(["skills", "mcp", "all"]);
export type ThreadExtensionsRefreshDomain = typeof ThreadExtensionsRefreshDomain.Type;

export const ThreadExtensionsGetSnapshotInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadExtensionsGetSnapshotInput = typeof ThreadExtensionsGetSnapshotInput.Type;

export const ThreadExtensionsGetPreviewSnapshotInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
});
export type ThreadExtensionsGetPreviewSnapshotInput =
  typeof ThreadExtensionsGetPreviewSnapshotInput.Type;

export const ThreadExtensionsRefreshInput = Schema.Struct({
  threadId: ThreadId,
  domain: Schema.optional(ThreadExtensionsRefreshDomain),
});
export type ThreadExtensionsRefreshInput = typeof ThreadExtensionsRefreshInput.Type;

export const ThreadExtensionsRefreshPreviewInput = Schema.Struct({
  ...ThreadExtensionsGetPreviewSnapshotInput.fields,
  domain: Schema.optional(ThreadExtensionsRefreshDomain),
});
export type ThreadExtensionsRefreshPreviewInput = typeof ThreadExtensionsRefreshPreviewInput.Type;

export const ThreadExtensionsSubscribeInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadExtensionsSubscribeInput = typeof ThreadExtensionsSubscribeInput.Type;

export const ThreadExtensionsMcpActionInput = Schema.Struct({
  threadId: ThreadId,
  mcpServerId: ProviderExtensionItemId,
});
export type ThreadExtensionsMcpActionInput = typeof ThreadExtensionsMcpActionInput.Type;

export const ThreadExtensionsMcpAuthInput = Schema.Struct({
  ...ThreadExtensionsMcpActionInput.fields,
  projectId: Schema.optional(ProjectId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.projectId === undefined) === (input.providerInstanceId === undefined) ||
      "projectId and providerInstanceId must be provided together",
  ),
);
export type ThreadExtensionsMcpAuthInput = typeof ThreadExtensionsMcpAuthInput.Type;

export const ThreadExtensionsMcpAuthCallbackInput = Schema.Struct({
  ...ThreadExtensionsMcpAuthInput.fields,
  callbackUrl: TrimmedNonEmptyString,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.projectId === undefined) === (input.providerInstanceId === undefined) ||
      "projectId and providerInstanceId must be provided together",
  ),
);
export type ThreadExtensionsMcpAuthCallbackInput = typeof ThreadExtensionsMcpAuthCallbackInput.Type;

export const ThreadExtensionsMcpAuthResult = Schema.Struct({
  snapshot: ThreadExtensionsSnapshot,
  authorizationUrl: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadExtensionsMcpAuthResult = typeof ThreadExtensionsMcpAuthResult.Type;

export const ThreadExtensionsStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: ThreadExtensionsSnapshot,
  }),
]);
export type ThreadExtensionsStreamItem = typeof ThreadExtensionsStreamItem.Type;

export class ThreadExtensionsRpcError extends Schema.TaggedErrorClass<ThreadExtensionsRpcError>()(
  "ThreadExtensionsRpcError",
  {
    reason: Schema.Literals([
      "thread-not-found",
      "provider-unavailable",
      "unsupported",
      "invalid-state",
      "invalid-callback",
      "provider-failed",
    ]),
    message: TrimmedNonEmptyString,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const EXTENSIONS_WS_METHODS = {
  getThreadSnapshot: "extensions.getThreadSnapshot",
  getPreviewSnapshot: "extensions.getPreviewSnapshot",
  refreshThread: "extensions.refreshThread",
  refreshPreview: "extensions.refreshPreview",
  subscribeThread: "extensions.subscribeThread",
  subscribePreview: "extensions.subscribePreview",
  reconnectMcp: "extensions.reconnectMcp",
  beginMcpAuth: "extensions.beginMcpAuth",
  relayMcpAuthCallback: "extensions.relayMcpAuthCallback",
} as const;

export const ThreadExtensionsRpcSchemas = {
  getThreadSnapshot: {
    input: ThreadExtensionsGetSnapshotInput,
    output: ThreadExtensionsSnapshot,
  },
  getPreviewSnapshot: {
    input: ThreadExtensionsGetPreviewSnapshotInput,
    output: ThreadExtensionsSnapshot,
  },
  refreshThread: {
    input: ThreadExtensionsRefreshInput,
    output: ThreadExtensionsSnapshot,
  },
  refreshPreview: {
    input: ThreadExtensionsRefreshPreviewInput,
    output: ThreadExtensionsSnapshot,
  },
  subscribeThread: {
    input: ThreadExtensionsSubscribeInput,
    output: ThreadExtensionsStreamItem,
  },
  subscribePreview: {
    input: ThreadExtensionsGetPreviewSnapshotInput,
    output: ThreadExtensionsStreamItem,
  },
  reconnectMcp: {
    input: ThreadExtensionsMcpActionInput,
    output: ThreadExtensionsSnapshot,
  },
  beginMcpAuth: {
    input: ThreadExtensionsMcpAuthInput,
    output: ThreadExtensionsMcpAuthResult,
  },
  relayMcpAuthCallback: {
    input: ThreadExtensionsMcpAuthCallbackInput,
    output: ThreadExtensionsSnapshot,
  },
} as const;
