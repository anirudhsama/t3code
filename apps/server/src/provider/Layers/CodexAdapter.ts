/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps the typed Codex session runtime behind the `CodexAdapter` service
 * contract and maps runtime failures into the shared `ProviderAdapterError`
 * algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type CodexSettings,
  type ProviderExtensionCapabilities,
  ProviderExtensionItemId,
  type ProviderExtensionOrigin,
  type ProviderExtensionScope,
  type ProviderMcpOverrides,
  type ProviderSkillOverrides,
  ProviderDriverKind,
  type ProviderEvent,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRequestKind,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeTaskUsage,
  ProviderApprovalDecision,
  ThreadId,
  ProviderSendTurnInput,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterStaleSkillSelectionError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import type {
  ProviderExtensionInventoryResult,
  ProviderExtensionManagementEvent,
  ProviderExtensionMcpFacet,
  ProviderExtensionReconciliationInput,
  ProviderExtensionReconciliationState,
  ProviderExtensionRuntimeContext,
  ProviderExtensionsShape,
  ProviderMcpInventoryItem,
  ProviderSkillInventoryItem,
} from "../Services/ThreadExtensions.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  CodexResumeCursorSchema,
  CodexSessionRuntimeThreadIdMissingError,
  makeCodexSessionRuntime,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeStartInput,
  type CodexSessionRuntimeShape,
} from "./CodexSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
const isCodexAppServerProcessExitedError = Schema.is(CodexErrors.CodexAppServerProcessExitedError);
const isCodexAppServerTransportError = Schema.is(CodexErrors.CodexAppServerTransportError);
const isCodexSessionRuntimeThreadIdMissingError = Schema.is(
  CodexSessionRuntimeThreadIdMissingError,
);
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);

const PROVIDER = ProviderDriverKind.make("codex");
const MANAGED_T3_MCP_SERVER_ID = ProviderExtensionItemId.make("t3-code");

export function compileCodexExtensionConfig(input: {
  readonly skillOverrides: ProviderSkillOverrides;
  readonly mcpOverrides: ProviderMcpOverrides;
}): Readonly<Record<string, unknown>> | undefined {
  const skills = Object.entries(input.skillOverrides).map(([path, state]) => ({
    path,
    enabled: state === "enabled",
  }));
  const mcpServers = Object.fromEntries(
    Object.entries(input.mcpOverrides)
      .filter(([name]) => name !== MANAGED_T3_MCP_SERVER_ID)
      .map(([name, state]) => [name, { enabled: state === "enabled" }]),
  );
  if (skills.length === 0 && Object.keys(mcpServers).length === 0) {
    return undefined;
  }
  return {
    ...(skills.length > 0 ? { skills: { config: skills } } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
  };
}

export const CODEX_EXTENSION_CAPABILITIES = {
  skills: {
    inventory: true,
    refresh: true,
    threadOverride: true,
  },
  mcp: {
    inventory: true,
    liveStatus: true,
    threadOverride: true,
    reconnect: false,
    authenticate: true,
  },
} as const satisfies ProviderExtensionCapabilities;

const CodexMcpConfigEnvelope = Schema.Struct({
  mcp_servers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const CodexMcpServerDefinition = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});
const decodeCodexMcpConfigEnvelope = Schema.decodeUnknownOption(CodexMcpConfigEnvelope);
const decodeCodexMcpServerDefinition = Schema.decodeUnknownOption(CodexMcpServerDefinition);

type CodexMcpDefinition = {
  readonly id: ProviderExtensionItemId;
  readonly name: string;
  readonly origins: ReadonlyArray<ProviderExtensionOrigin>;
  readonly providerEnabled: boolean;
  readonly managed: boolean;
  readonly toggleable: boolean;
};

type CodexMcpLiveStatus = {
  readonly startupStatus: ProviderMcpInventoryItem["startupStatus"];
  readonly authStatus: ProviderMcpInventoryItem["authStatus"];
  readonly error?: string;
  readonly serverInfo?: unknown;
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly resourceTemplateCount: number;
};

function codexSkillScope(
  scope: EffectCodexSchema.V2SkillsListResponse__SkillScope,
): ProviderExtensionScope {
  return scope === "repo" ? "project" : scope;
}

function codexConfigLayerOrigin(
  source: EffectCodexSchema.V2ConfigReadResponse__ConfigLayerSource,
  effective: boolean,
): ProviderExtensionOrigin {
  switch (source.type) {
    case "project":
      return {
        scope: "project",
        label: "Project config",
        path: source.dotCodexFolder,
        effective,
        metadata: source,
      };
    case "user":
      return {
        scope: "user",
        label: source.profile ? `User config (${source.profile})` : "User config",
        path: source.file,
        effective,
        metadata: source,
      };
    case "system":
      return {
        scope: "system",
        label: "System config",
        path: source.file,
        effective,
        metadata: source,
      };
    case "sessionFlags":
      return {
        scope: "unknown",
        label: "Runtime configuration",
        effective,
        metadata: source,
      };
    case "enterpriseManaged":
      return {
        scope: "admin",
        label: source.name,
        effective,
        metadata: source,
      };
    case "mdm":
      return {
        scope: "admin",
        label: `Managed configuration (${source.domain})`,
        effective,
        metadata: source,
      };
    case "legacyManagedConfigTomlFromFile":
      return {
        scope: "admin",
        label: "Managed config",
        path: source.file,
        effective,
        metadata: source,
      };
    case "legacyManagedConfigTomlFromMdm":
      return {
        scope: "admin",
        label: "Managed configuration",
        effective,
        metadata: source,
      };
  }
}

function configLayerIdentity(input: {
  readonly name: EffectCodexSchema.V2ConfigReadResponse__ConfigLayerSource;
  readonly version: string;
}): string {
  return JSON.stringify({ name: input.name, version: input.version });
}

function readMcpServers(config: unknown): Readonly<Record<string, unknown>> {
  return Option.match(decodeCodexMcpConfigEnvelope(config), {
    onNone: () => ({}),
    onSome: (decoded) => decoded.mcp_servers ?? {},
  });
}

export function parseCodexMcpDefinitions(
  response: EffectCodexSchema.V2ConfigReadResponse,
  managedServerIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<CodexMcpDefinition> {
  const effectiveServers = readMcpServers(response.config);
  const layers = response.layers ?? [];

  const definitions = Object.entries(effectiveServers).map(([name, rawDefinition]) => {
    const effectiveDefinition = Option.getOrUndefined(
      decodeCodexMcpServerDefinition(rawDefinition),
    );
    const originMetadata =
      response.origins[`mcp_servers.${name}`] ?? response.origins[`mcp_servers.${name}.enabled`];
    const effectiveOriginIdentity = originMetadata
      ? configLayerIdentity(originMetadata)
      : undefined;
    const contributingLayers = layers.filter((layer) =>
      Object.hasOwn(readMcpServers(layer.config), name),
    );
    const fallbackWinner = contributingLayers.at(-1);
    const origins = contributingLayers.map((layer) =>
      codexConfigLayerOrigin(
        layer.name,
        effectiveOriginIdentity
          ? configLayerIdentity(layer) === effectiveOriginIdentity
          : layer === fallbackWinner,
      ),
    );
    const managed = managedServerIds.has(name);

    return {
      id: ProviderExtensionItemId.make(name),
      name,
      origins,
      providerEnabled: managed || effectiveDefinition?.enabled !== false,
      managed,
      toggleable: !managed,
    };
  });
  for (const name of managedServerIds) {
    if (definitions.some((definition) => definition.name === name)) {
      continue;
    }
    definitions.push({
      id: ProviderExtensionItemId.make(name),
      name,
      origins: [
        {
          scope: "unknown",
          label: "Runtime configuration",
          effective: true,
          metadata: { type: "sessionFlags" },
        },
      ],
      providerEnabled: true,
      managed: true,
      toggleable: false,
    });
  }
  return definitions;
}

function codexMcpAuthStatus(
  status: EffectCodexSchema.V2ListMcpServerStatusResponse__McpAuthStatus,
): ProviderMcpInventoryItem["authStatus"] {
  switch (status) {
    case "notLoggedIn":
      return "needs-auth";
    case "bearerToken":
    case "oAuth":
      return "authenticated";
    case "unsupported":
      return "unsupported";
  }
}

function parseCodexMcpLiveStatus(
  status: EffectCodexSchema.V2ListMcpServerStatusResponse__McpServerStatus,
): CodexMcpLiveStatus {
  return {
    startupStatus: status.serverInfo ? "ready" : "unknown",
    authStatus: codexMcpAuthStatus(status.authStatus),
    ...(status.serverInfo ? { serverInfo: status.serverInfo } : {}),
    toolCount: Object.keys(status.tools).length,
    resourceCount: status.resources.length,
    resourceTemplateCount: status.resourceTemplates.length,
  };
}

function emptyCodexMcpLiveStatus(providerEnabled: boolean): CodexMcpLiveStatus {
  return {
    startupStatus: providerEnabled ? "unknown" : "disabled",
    authStatus: "unknown",
    toolCount: 0,
    resourceCount: 0,
    resourceTemplateCount: 0,
  };
}

export function parseCodexSkillsInventory(
  response: EffectCodexSchema.V2SkillsListResponse,
  cwd: string,
): {
  readonly items: ReadonlyArray<ProviderSkillInventoryItem>;
  readonly warnings: ReadonlyArray<string>;
} {
  const entry = response.data.find((candidate) => candidate.cwd === cwd);
  if (!entry) {
    return { items: [], warnings: [] };
  }

  return {
    items: entry.skills.map((skill) => {
      const scope = codexSkillScope(skill.scope);
      const displayName = skill.interface?.displayName ?? undefined;
      const description =
        skill.description ||
        skill.shortDescription ||
        skill.interface?.shortDescription ||
        undefined;
      return {
        id: ProviderExtensionItemId.make(skill.path),
        name: skill.name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        scope,
        path: skill.path,
        providerEnabled: skill.enabled,
        origin: {
          scope,
          path: skill.path,
          effective: skill.enabled,
        },
      } satisfies ProviderSkillInventoryItem;
    }),
    warnings: entry.errors.map((error) => `${error.path}: ${error.message}`),
  };
}

export interface CodexAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    options: CodexSessionRuntimeOptions,
  ) => Effect.Effect<
    CodexSessionRuntimeShape,
    CodexSessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface CodexAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly mcpProviderSessionId: string | null;
  readonly scope: Scope.Closeable;
  readonly runtime: CodexSessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  started: boolean;
  stopped: boolean;
}

interface CodexInventoryCacheState<Item> {
  readonly cache: Map<string, ProviderExtensionInventoryResult<Item>>;
  readonly regularInFlight: Map<
    string,
    Deferred.Deferred<ProviderExtensionInventoryResult<Item>, ProviderAdapterError>
  >;
  readonly forceInFlight: Map<
    string,
    Deferred.Deferred<ProviderExtensionInventoryResult<Item>, ProviderAdapterError>
  >;
  readonly latestRequest: Map<
    string,
    {
      readonly id: number;
      readonly deferred: Deferred.Deferred<
        ProviderExtensionInventoryResult<Item>,
        ProviderAdapterError
      >;
    }
  >;
}

function makeCodexInventoryCacheState<Item>(): CodexInventoryCacheState<Item> {
  return {
    cache: new Map(),
    regularInFlight: new Map(),
    forceInFlight: new Map(),
    latestRequest: new Map(),
  };
}

function mapCodexRuntimeError(
  threadId: ThreadId,
  method: string,
  error: CodexSessionRuntimeError,
): ProviderAdapterError {
  if (isCodexAppServerProcessExitedError(error) || isCodexAppServerTransportError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  if (isCodexSessionRuntimeThreadIdMissingError(error)) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"];

type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  const isPayload = Schema.is(schema);
  return isPayload(payload) ? payload : undefined;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): ThreadTokenUsageSnapshot | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType, item?: CodexLifecycleItem): string | undefined {
  if (itemType === "mcp_tool_call" && item?.type === "mcpToolCall") {
    return `${item.server} · ${item.tool}`;
  }
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function itemDetail(itemType: CanonicalItemType, item: CodexLifecycleItem): string | undefined {
  const itemRecord = item as Record<string, unknown>;
  const action = itemRecord.action as Record<string, unknown> | undefined;
  const actionQueries = Array.isArray(action?.queries) ? action.queries : [];
  const candidates = [
    ...(itemType === "web_search"
      ? [itemRecord.query, action?.query, ...actionQueries, action?.pattern, action?.url]
      : []),
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];

  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions
    .map((question) => {
      const options =
        question.options
          ?.map((option) => {
            const label = trimText(option.label);
            const description = trimText(option.description);
            if (!label || !description) {
              return undefined;
            }
            return { label, description };
          })
          .filter((option) => option !== undefined) ?? [];

      const id = trimText(question.id);
      const header = trimText(question.header);
      const prompt = trimText(question.question);
      if (!id || !header || !prompt || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      };
    })
    .filter((question) => question !== undefined);

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item) {
    return undefined;
  }
  const itemType = toCanonicalItemType(item.type);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(itemType, item);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType, item) ? { title: itemTitle(itemType, item) } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: event.payload } : {}),
    },
  };
}

/**
 * Maps the session runtime's synthetic `collabAgent/*` events (native
 * multi-agent v2 child-thread signals) into the shared task.* lifecycle.
 * Agent identity = child thread id; nickname is the display title, role is
 * agentRole (fallback: last agentPath segment, then "general-purpose").
 * A completed child turn is idle (resumable), not terminal. timelineBypass
 * keeps these rows out of the parent chat.
 */
function mapCollabAgentEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : undefined;
  const agentThreadId = typeof payload?.agentThreadId === "string" ? payload.agentThreadId : "";
  if (!payload || agentThreadId.length === 0) {
    return [];
  }
  const base = runtimeEventBase(event, canonicalThreadId);
  const taskId = RuntimeTaskId.make(agentThreadId);
  const agentPath = typeof payload.agentPath === "string" ? payload.agentPath : undefined;
  const pathLeaf = agentPath?.split("/").findLast((segment) => segment.length > 0);
  const nickname = typeof payload.nickname === "string" ? payload.nickname : undefined;
  const role =
    (typeof payload.role === "string" ? payload.role : undefined) ?? pathLeaf ?? "general-purpose";
  // A bare thread id is not a name. Omitting the title lets the client fold
  // keep the real one from task.started instead of clobbering it (probe
  // finding: progress rows renamed math_one to its UUID).
  const knownName = nickname ?? pathLeaf;
  const title = knownName ?? agentThreadId;
  // Identity repeated on every status patch so rows are self-describing when
  // the start row ages out of activity retention (review finding: a
  // reconstructed agent had a UUID name and no role/path).
  const statusLinkage = {
    role,
    ...(knownName ? { title: knownName } : {}),
    ...(agentPath ? { agentPath } : {}),
    timelineBypass: true,
  } as const;

  switch (event.method) {
    case "collabAgent/started":
      return [
        {
          ...base,
          type: "task.started",
          payload: {
            taskId,
            description: title,
            title,
            role,
            ...(agentPath ? { agentPath } : {}),
            ...(typeof payload.parentThreadId === "string"
              ? { parentAgentId: payload.parentThreadId }
              : {}),
            timelineBypass: true,
          },
        },
      ];
    case "collabAgent/activity": {
      const activityKind = typeof payload.activityKind === "string" ? payload.activityKind : "";
      if (activityKind === "interrupted") {
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "interrupted", ...statusLinkage },
          },
        ];
      }
      if (activityKind === "started") {
        // Wire-probe finding: children often register via subAgentActivity
        // alone (no thread/started with a spawn source), so this is the one
        // shot at a task.started with a real name — agentPath leaf beats a
        // bare thread-id title.
        return [
          {
            ...base,
            type: "task.started",
            payload: {
              taskId,
              description: title,
              title,
              role,
              ...(agentPath ? { agentPath } : {}),
              timelineBypass: true,
            },
          },
        ];
      }
      // interacted → the child is (again) actively driven.
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "running", ...statusLinkage },
        },
      ];
    }
    case "collabAgent/turnStarted":
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "running", ...statusLinkage },
        },
      ];
    case "collabAgent/turnCompleted": {
      // Idle, not terminal: the identity is resumable via sendInput/resume.
      const turn =
        typeof payload.turn === "object" && payload.turn !== null
          ? (payload.turn as Record<string, unknown>)
          : undefined;
      const turnStatus = typeof turn?.status === "string" ? turn.status : undefined;
      const status =
        turnStatus === "failed"
          ? ("failed" as const)
          : turnStatus === "interrupted"
            ? ("interrupted" as const)
            : ("idle" as const);
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status, ...statusLinkage },
        },
      ];
    }
    case "collabAgent/statusChanged": {
      const status =
        typeof payload.status === "object" && payload.status !== null
          ? (payload.status as Record<string, unknown>)
          : undefined;
      const statusType = typeof status?.type === "string" ? status.type : undefined;
      if (statusType === "systemError") {
        // Silently dropping this once left children stuck running forever.
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "failed", ...statusLinkage },
          },
        ];
      }
      if (statusType === "active") {
        const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
        const waiting = flags.some(
          (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
        );
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: waiting ? "waiting" : "running", ...statusLinkage },
          },
        ];
      }
      if (statusType === "idle") {
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "idle", ...statusLinkage },
          },
        ];
      }
      return [];
    }
    case "collabAgent/tokenUsage": {
      // Cumulative per child thread: always the `total` breakdown, never
      // `last` (which shrinks on follow-ups). Client folds max-merge.
      const tokenUsage =
        typeof payload.tokenUsage === "object" && payload.tokenUsage !== null
          ? (payload.tokenUsage as Record<string, unknown>)
          : undefined;
      const total =
        typeof tokenUsage?.total === "object" && tokenUsage.total !== null
          ? (tokenUsage.total as Record<string, unknown>)
          : undefined;
      const count = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
      // Same validation as every other field: RuntimeTaskUsage.totalTokens
      // is NonNegativeInt, so NaN/Infinity/negative wire values must miss.
      const totalTokens = count(total?.totalTokens);
      if (totalTokens === undefined) {
        return [];
      }
      const typedUsage: RuntimeTaskUsage = {
        totalTokens,
        ...(count(total?.inputTokens) !== undefined
          ? { inputTokens: count(total?.inputTokens) }
          : {}),
        ...(count(total?.cachedInputTokens) !== undefined
          ? { cachedInputTokens: count(total?.cachedInputTokens) }
          : {}),
        ...(count(total?.outputTokens) !== undefined
          ? { outputTokens: count(total?.outputTokens) }
          : {}),
        ...(count(total?.reasoningOutputTokens) !== undefined
          ? { reasoningOutputTokens: count(total?.reasoningOutputTokens) }
          : {}),
      };
      return [
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            description: title,
            ...(knownName ? { title: knownName } : {}),
            typedUsage,
            timelineBypass: true,
          },
        },
      ];
    }
    case "collabAgent/item": {
      const item =
        typeof payload.item === "object" && payload.item !== null
          ? (payload.item as Record<string, unknown>)
          : undefined;
      const itemTypeRaw = typeof item?.type === "string" ? item.type : undefined;
      if (!itemTypeRaw) {
        return [];
      }
      // A loose summary from the raw item: the child stream is untyped at
      // this boundary (synthetic event payload), so read best-effort fields
      // rather than force a schema decode.
      const looseSummary =
        (typeof item?.command === "string" ? item.command : undefined) ??
        (typeof item?.title === "string" ? item.title : undefined) ??
        (typeof item?.query === "string" ? item.query : undefined);
      const canonical = toCanonicalItemType(itemTypeRaw);
      const summary = looseSummary ?? canonical.replaceAll("_", " ");
      return [
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            description: title,
            ...(knownName ? { title: knownName } : {}),
            summary,
            timelineBypass: true,
          },
        },
      ];
    }
    case "collabAgent/closed":
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "interrupted", ...statusLinkage },
        },
      ];
    default:
      return [];
  }
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "notification" && event.method.startsWith("collabAgent/")) {
    return mapCollabAgentEvent(event, canonicalThreadId);
  }
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);
      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );
          return payload?.command ?? payload?.reason ?? undefined;
        }
        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );
          return payload?.reason ?? payload?.command.join(" ");
        }
        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );
          return payload?.tool ?? undefined;
        }
        default:
          return undefined;
      }
    })();

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = readPayload(ApprovalDecisionPayload, event.payload);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(payload ? { decision: payload.decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payload = readPayload(EffectCodexSchema.V2ThreadStartedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId: payload.thread.id,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    const payload =
      event.method === "thread/status/changed"
        ? readPayload(EffectCodexSchema.V2ThreadStatusChangedNotification, event.payload)
        : undefined;
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : payload
                    ? toThreadState(payload.status)
                    : "active",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadNameUpdatedNotification, event.payload);
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(trimText(payload?.threadName) ? { name: trimText(payload?.threadName) } : {}),
          ...(payload
            ? {
                metadata: {
                  threadId: payload.threadId,
                  ...(payload.threadName !== undefined && payload.threadName !== null
                    ? { threadName: payload.threadName }
                    : {}),
                },
              }
            : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
      event.payload,
    );
    const normalizedUsage = payload ? normalizeCodexTokenUsage(payload.tokenUsage) : undefined;
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const errorMessage = trimText(payload.turn.error?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(payload.turn.status),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnPlanUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(trimText(payload.explanation) ? { explanation: trimText(payload.explanation) } : {}),
          plan: payload.plan.map((step) => ({
            step: trimText(step.step) ?? "step",
            status:
              step.status === "completed" || step.status === "inProgress" ? step.status : "pending",
          })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnDiffUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff: payload.diff,
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
    const item = payload?.item;
    if (!item) {
      return [];
    }
    const itemType = toCanonicalItemType(item.type);
    if (itemType === "plan") {
      const detail = itemDetail(itemType, item);
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType:
            event.method === "item/reasoning/summaryPartAdded" ? "reasoning" : "command_execution",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/plan/delta") {
    const payload = readPayload(EffectCodexSchema.V2PlanDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    const payload = readPayload(EffectCodexSchema.V2AgentMessageDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
        },
      },
    ];
  }

  if (event.method === "item/commandExecution/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2CommandExecutionOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "command_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/fileChange/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2FileChangeOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "file_change_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2ReasoningSummaryTextDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_summary_text",
          delta,
          ...(payload ? { summaryIndex: payload.summaryIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/reasoning/textDelta") {
    const payload = readPayload(EffectCodexSchema.V2ReasoningTextDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta,
          ...(payload ? { contentIndex: payload.contentIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const payload = readPayload(EffectCodexSchema.V2McpToolCallProgressNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          summary: payload.message,
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const payload = readPayload(
      EffectCodexSchema.V2ServerRequestResolvedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const requestType = toRequestTypeFromKind(event.requestKind);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    const payload = readPayload(EffectCodexSchema.ToolRequestUserInputResponse, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(payload.answers),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    const payload = readPayload(EffectCodexSchema.V2ModelReroutedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: payload.fromModel,
          toModel: payload.toModel,
          reason: payload.reason,
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    const payload = readPayload(EffectCodexSchema.V2DeprecationNoticeNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const payload = readPayload(EffectCodexSchema.V2ConfigWarningNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
          ...(trimText(payload.path) ? { path: trimText(payload.path) } : {}),
          ...(payload.range !== undefined && payload.range !== null
            ? { range: payload.range }
            : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountRateLimitsUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2McpServerOauthLoginCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload.success,
          name: payload.name,
          ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeStartedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId: payload.realtimeSessionId ?? undefined,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeItemAddedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: payload.item,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: payload.audio,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const payload = readPayload(EffectCodexSchema.V2ThreadRealtimeErrorNotification, event.payload);
    const message = payload?.message ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeClosedNotification,
      event.payload,
    );
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: payload?.reason ?? event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
    const message = payload?.error.message ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              class: "provider_error" as const,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    if (!readPayload(EffectCodexSchema.V2WindowsWorldWritableWarningNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payload = readPayload(
      EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: payload.success === false ? "error" : "ready",
          reason: payload.success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(payload.success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

/**
 * Build a Codex provider adapter bound to a specific `CodexSettings` payload.
 *
 * The adapter is a captured closure over `codexConfig` — the `binaryPath` and
 * `homePath` are read from that payload, not from `ServerSettingsService`.
 * This is what makes multi-instance routing possible: each `ProviderInstance`
 * in the registry owns its own closure with its own config, so two Codex
 * instances with different `homePath`s cannot step on each other.
 */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  codexConfig: CodexSettings,
  options?: CodexAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("codex");
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const extensionEvents = yield* PubSub.unbounded<ProviderExtensionManagementEvent>();
  const sessions = new Map<ThreadId, CodexAdapterSessionContext>();
  const skillInventoryCache = makeCodexInventoryCacheState<ProviderSkillInventoryItem>();
  const mcpDefinitionCache = makeCodexInventoryCacheState<CodexMcpDefinition>();
  const mcpStatusCache = makeCodexInventoryCacheState<readonly [string, CodexMcpLiveStatus]>();
  const mcpNotificationStatus = new Map<ThreadId, Map<string, Partial<CodexMcpLiveStatus>>>();
  const mcpNotificationRevision = new Map<ThreadId, number>();
  const desiredExtensionOverrides = new Map<ThreadId, ProviderExtensionReconciliationInput>();
  const extensionReconciliationStates = new Map<ThreadId, ProviderExtensionReconciliationState>();
  let nextInventoryRequestId = 0;
  let inventoryRevision = 0;

  const cacheKey = (cwd: string) => `${boundInstanceId}\u0000${cwd}`;
  const canonicalizeCwd = (cwd: string) =>
    fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));

  const reconciliationState = (threadId: ThreadId): ProviderExtensionReconciliationState =>
    extensionReconciliationStates.get(threadId) ?? { appliedOverrideRevision: 0 };

  const publishReconciliationState = Effect.fnUntraced(function* (
    input: ProviderExtensionReconciliationInput,
    state: ProviderExtensionReconciliationState,
  ) {
    desiredExtensionOverrides.set(input.threadId, input);
    extensionReconciliationStates.set(input.threadId, state);
    yield* PubSub.publish(extensionEvents, {
      type: "overrides.reconciliation.changed",
      threadId: input.threadId,
      cwd: input.cwd,
      state,
    });
    return state;
  });

  const readCachedInventory = <Item>(input: {
    readonly state: CodexInventoryCacheState<Item>;
    readonly key: string;
    readonly forceReload: boolean;
    readonly load: () => Effect.Effect<
      {
        readonly items: ReadonlyArray<Item>;
        readonly warnings?: ReadonlyArray<string>;
      },
      ProviderAdapterError
    >;
  }): Effect.Effect<ProviderExtensionInventoryResult<Item>, ProviderAdapterError> =>
    Effect.gen(function* () {
      if (!input.forceReload) {
        const cached = input.state.cache.get(input.key);
        if (cached) {
          return cached;
        }
      }

      const candidate = input.forceReload
        ? input.state.forceInFlight.get(input.key)
        : (input.state.forceInFlight.get(input.key) ?? input.state.regularInFlight.get(input.key));
      if (candidate) {
        return yield* Deferred.await(candidate);
      }

      const deferred = yield* Deferred.make<
        ProviderExtensionInventoryResult<Item>,
        ProviderAdapterError
      >();
      const requestId = ++nextInventoryRequestId;
      const inFlight = input.forceReload ? input.state.forceInFlight : input.state.regularInFlight;
      inFlight.set(input.key, deferred);
      input.state.latestRequest.set(input.key, { id: requestId, deferred });

      const loaded = yield* input.load().pipe(Effect.exit);
      const latest = input.state.latestRequest.get(input.key);
      if (latest && latest.id !== requestId) {
        const latestResult = yield* Deferred.await(latest.deferred).pipe(Effect.exit);
        yield* Deferred.done(deferred, latestResult);
        if (inFlight.get(input.key) === deferred) {
          inFlight.delete(input.key);
        }
        return yield* latestResult;
      }

      if (Exit.isFailure(loaded)) {
        yield* Deferred.failCause(deferred, loaded.cause);
        if (inFlight.get(input.key) === deferred) {
          inFlight.delete(input.key);
        }
        return yield* Effect.failCause(loaded.cause);
      }

      const result = {
        items: loaded.value.items,
        revision: ++inventoryRevision,
        warnings: loaded.value.warnings ?? [],
      } satisfies ProviderExtensionInventoryResult<Item>;
      input.state.cache.set(input.key, result);
      if (inFlight.get(input.key) === deferred) {
        inFlight.delete(input.key);
      }
      yield* Deferred.succeed(deferred, result);
      return result;
    });

  const buildRuntimeOptions = (
    input: ProviderSessionStartInput & { readonly cwd: string },
  ): CodexSessionRuntimeOptions => {
    const serviceTier =
      input.modelSelection?.instanceId === boundInstanceId
        ? getCodexServiceTierOptionValue(input.modelSelection)
        : undefined;
    const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
    const extensionConfig = input.extensionOverrides
      ? compileCodexExtensionConfig({
          skillOverrides: input.extensionOverrides.skills,
          mcpOverrides: input.extensionOverrides.mcp,
        })
      : undefined;
    return {
      threadId: input.threadId,
      providerInstanceId: boundInstanceId,
      cwd: input.cwd,
      binaryPath: codexConfig.binaryPath,
      launchArgs: resolveCodexLaunchArgs(codexConfig.launchArgs, options?.environment),
      ...(options?.environment ? { environment: options.environment } : {}),
      ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
      ...(isCodexResumeCursorSchema(input.resumeCursor)
        ? { resumeCursor: input.resumeCursor }
        : {}),
      runtimeMode: input.runtimeMode,
      ...(input.modelSelection?.instanceId === boundInstanceId
        ? { model: input.modelSelection.model }
        : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(extensionConfig ? { config: extensionConfig } : {}),
      ...(mcpSession
        ? {
            environment: {
              ...(options?.environment ?? process.env),
              T3_MCP_BEARER_TOKEN: mcpSession.authorizationHeader.replace(/^Bearer\s+/, ""),
            },
            appServerArgs: [
              "-c",
              `mcp_servers.t3-code.url=${mcpSession.endpoint}`,
              "-c",
              'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
            ],
          }
        : {}),
    };
  };

  const createSessionContext = Effect.fn("CodexAdapter.createSessionContext")(function* (
    runtimeInput: CodexSessionRuntimeOptions,
  ) {
    const sessionScope = yield* Scope.make("sequential");
    const createRuntime = options?.makeRuntime ?? makeCodexSessionRuntime;
    const runtime = yield* createRuntime(runtimeInput).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: runtimeInput.threadId,
            detail: cause.message,
            cause,
          }),
      ),
      Effect.onError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)),
    );

    const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
      Effect.gen(function* () {
        yield* writeNativeEvent(event);
        yield* handleExtensionRuntimeEvent(event);
        const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
        if (runtimeEvents.length === 0) {
          if (
            event.method !== "skills/changed" &&
            event.method !== "mcpServer/startupStatus/updated" &&
            event.method !== "mcpServer/oauthLogin/completed"
          ) {
            yield* Effect.logDebug("ignoring unhandled Codex provider event", {
              method: event.method,
              threadId: event.threadId,
              turnId: event.turnId,
              itemId: event.itemId,
            });
          }
          return;
        }
        yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
      }),
    ).pipe(Effect.forkIn(sessionScope));

    const context: CodexAdapterSessionContext = {
      threadId: runtimeInput.threadId,
      cwd: runtimeInput.cwd,
      mcpProviderSessionId:
        McpProviderSession.readMcpProviderSession(runtimeInput.threadId)?.providerSessionId ?? null,
      scope: sessionScope,
      runtime,
      eventFiber,
      started: false,
      stopped: false,
    };
    sessions.set(runtimeInput.threadId, context);
    return context;
  });

  const ensureExtensionContext = Effect.fn("CodexAdapter.ensureExtensionContext")(function* (
    input: ProviderExtensionRuntimeContext,
  ) {
    const cwd = yield* canonicalizeCwd(input.cwd);
    const existing = sessions.get(input.threadId);
    if (existing && !existing.stopped && existing.cwd === cwd) {
      return existing;
    }
    if (existing && !existing.stopped) {
      skillInventoryCache.cache.delete(cacheKey(existing.cwd));
      mcpDefinitionCache.cache.delete(cacheKey(existing.cwd));
      yield* Effect.suspend(() => stopSessionInternal(existing));
    }

    return yield* createSessionContext(
      buildRuntimeOptions({
        threadId: input.threadId,
        cwd,
        runtimeMode: input.runtimeMode ?? "full-access",
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
      }),
    );
  });

  const startSession: CodexAdapterShape["startSession"] = Effect.fn("CodexAdapter.startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const cwd = yield* canonicalizeCwd(input.cwd ?? process.cwd());
      const mcpProviderSessionId =
        McpProviderSession.readMcpProviderSession(input.threadId)?.providerSessionId ?? null;
      let context = sessions.get(input.threadId);
      let reusePreparedRuntime =
        context !== undefined &&
        !context.stopped &&
        !context.started &&
        context.cwd === cwd &&
        context.mcpProviderSessionId === mcpProviderSessionId;
      if (context && !context.stopped && !reusePreparedRuntime) {
        mcpDefinitionCache.cache.delete(cacheKey(context.cwd));
        yield* stopSessionInternal(context);
        context = undefined;
      }
      if (!context) {
        context = yield* createSessionContext(buildRuntimeOptions({ ...input, cwd }));
        reusePreparedRuntime = false;
      }

      const serviceTier =
        input.modelSelection?.instanceId === boundInstanceId
          ? getCodexServiceTierOptionValue(input.modelSelection)
          : undefined;
      const extensionConfig = input.extensionOverrides
        ? compileCodexExtensionConfig({
            skillOverrides: input.extensionOverrides.skills,
            mcpOverrides: input.extensionOverrides.mcp,
          })
        : undefined;
      const extensionInput = input.extensionOverrides
        ? ({
            threadId: input.threadId,
            cwd,
            runtimeMode: input.runtimeMode,
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
            skillOverrides: input.extensionOverrides.skills,
            mcpOverrides: input.extensionOverrides.mcp,
            extensionOverridesRevision: input.extensionOverrides.revision,
          } satisfies ProviderExtensionReconciliationInput)
        : undefined;
      const startInput: CodexSessionRuntimeStartInput = {
        cwd,
        runtimeMode: input.runtimeMode,
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(isCodexResumeCursorSchema(input.resumeCursor)
          ? { resumeCursor: input.resumeCursor }
          : {}),
        ...(extensionConfig ? { config: extensionConfig } : {}),
      };
      if (extensionInput) {
        const current = reconciliationState(input.threadId);
        yield* publishReconciliationState(extensionInput, {
          appliedOverrideRevision: current.appliedOverrideRevision,
          pendingOverrideRevision: extensionInput.extensionOverridesRevision,
        });
      }
      const started = yield* context.runtime
        .start(reusePreparedRuntime ? startInput : undefined)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.tapError((error) =>
            extensionInput
              ? publishReconciliationState(extensionInput, {
                  appliedOverrideRevision: reconciliationState(input.threadId)
                    .appliedOverrideRevision,
                  pendingOverrideRevision: extensionInput.extensionOverridesRevision,
                  error: {
                    domain: "all",
                    message: error.message,
                    retryable: true,
                  },
                }).pipe(Effect.ignore)
              : Effect.void,
          ),
          Effect.onError(() => stopSessionInternal(context).pipe(Effect.ignore)),
        );
      if (extensionInput) {
        yield* context.runtime.listMcpServerStatus.pipe(
          Effect.tapError((cause) =>
            publishReconciliationState(extensionInput, {
              appliedOverrideRevision: reconciliationState(input.threadId).appliedOverrideRevision,
              pendingOverrideRevision: extensionInput.extensionOverridesRevision,
              error: {
                domain: "all",
                message: cause.cause instanceof Error ? cause.cause.message : cause.message,
                retryable: true,
              },
            }).pipe(Effect.ignore),
          ),
          Effect.mapError((cause) =>
            mapCodexRuntimeError(input.threadId, "mcpServerStatus/list", cause),
          ),
          Effect.onError(() => stopSessionInternal(context).pipe(Effect.ignore)),
        );
        yield* publishReconciliationState(extensionInput, {
          appliedOverrideRevision: extensionInput.extensionOverridesRevision,
        });
      }
      context.started = true;
      mcpStatusCache.cache.delete(input.threadId);
      return started;
    },
  );

  const readSkillInventory = Effect.fn("CodexAdapter.readSkillInventory")(function* (
    input: ProviderExtensionRuntimeContext & { readonly forceReload: boolean },
  ) {
    const context = yield* ensureExtensionContext(input);
    const key = cacheKey(context.cwd);
    return yield* readCachedInventory({
      state: skillInventoryCache,
      key,
      forceReload: input.forceReload,
      load: () =>
        context.runtime
          .listSkills({
            cwd: context.cwd,
            ...(input.forceReload ? { forceReload: true } : {}),
          })
          .pipe(
            Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "skills/list", cause)),
            Effect.flatMap((response) => {
              const parsed = parseCodexSkillsInventory(response, context.cwd);
              return Effect.forEach(
                parsed.items,
                (skill) =>
                  skill.path
                    ? fileSystem.realPath(skill.path).pipe(
                        Effect.orElseSucceed(() => skill.path!),
                        Effect.map((canonicalPath) => ({
                          ...skill,
                          id: ProviderExtensionItemId.make(canonicalPath),
                          path: canonicalPath,
                          ...(skill.origin
                            ? {
                                origin: {
                                  ...skill.origin,
                                  path: canonicalPath,
                                },
                              }
                            : {}),
                        })),
                      )
                    : Effect.succeed(skill),
                { concurrency: "unbounded" },
              ).pipe(
                Effect.map((items) => ({
                  items,
                  warnings: parsed.warnings,
                })),
              );
            }),
          ),
    });
  });

  const readMcpDefinitions = Effect.fn("CodexAdapter.readMcpDefinitions")(function* (
    input: ProviderExtensionRuntimeContext & { readonly forceReload: boolean },
  ) {
    const context = yield* ensureExtensionContext(input);
    const key = cacheKey(context.cwd);
    return yield* readCachedInventory({
      state: mcpDefinitionCache,
      key,
      forceReload: input.forceReload,
      load: () =>
        context.runtime.readMcpConfig(context.cwd).pipe(
          Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "config/read", cause)),
          Effect.map((response) => ({
            items: parseCodexMcpDefinitions(
              response,
              McpProviderSession.readMcpProviderSession(input.threadId)
                ? new Set([MANAGED_T3_MCP_SERVER_ID])
                : new Set(),
            ),
          })),
        ),
    });
  });

  const readMcpStatus = Effect.fn("CodexAdapter.readMcpStatus")(function* (
    input: ProviderExtensionRuntimeContext & { readonly forceReload: boolean },
  ) {
    const context = yield* ensureExtensionContext(input);
    return yield* readCachedInventory({
      state: mcpStatusCache,
      key: input.threadId,
      forceReload: input.forceReload,
      load: () =>
        context.runtime.listMcpServerStatus.pipe(
          Effect.mapError((cause) =>
            mapCodexRuntimeError(input.threadId, "mcpServerStatus/list", cause),
          ),
          Effect.map((response) => ({
            items: response.data.map(
              (status) => [status.name, parseCodexMcpLiveStatus(status)] as const,
            ),
          })),
        ),
    });
  });

  const readMcpInventory: ProviderExtensionMcpFacet["inventory"] = Effect.fn(
    "CodexAdapter.readMcpInventory",
  )(function* (input) {
    const forceReload = input.forceReload === true;
    const [definitions, liveStatuses] = yield* Effect.all(
      [readMcpDefinitions({ ...input, forceReload }), readMcpStatus({ ...input, forceReload })],
      { concurrency: "unbounded" },
    );
    const statuses = new Map(liveStatuses.items);
    const notifications = mcpNotificationStatus.get(input.threadId);
    const items = definitions.items.map((definition) => {
      const baseStatus =
        statuses.get(definition.name) ?? emptyCodexMcpLiveStatus(definition.providerEnabled);
      const status = {
        ...baseStatus,
        ...notifications?.get(definition.name),
      };
      return {
        ...definition,
        ...status,
      } satisfies ProviderMcpInventoryItem;
    });
    return {
      items,
      revision: Math.max(
        definitions.revision,
        liveStatuses.revision,
        mcpNotificationRevision.get(input.threadId) ?? 0,
      ),
      warnings: [...definitions.warnings, ...liveStatuses.warnings],
    };
  });

  const skillsFacet = {
    inventory: (input) =>
      readSkillInventory({
        ...input,
        forceReload: input.forceReload === true,
      }),
    refresh: (input) => readSkillInventory({ ...input, forceReload: true }),
  } satisfies NonNullable<ProviderExtensionsShape["skills"]>;

  const mcpFacet = {
    inventory: readMcpInventory,
    refresh: (input) => readMcpInventory({ ...input, forceReload: true }),
    authenticate: (input) =>
      ensureExtensionContext(input).pipe(
        Effect.flatMap((context) =>
          context.runtime
            .beginMcpAuth(input.mcpServerId)
            .pipe(
              Effect.mapError((cause) =>
                mapCodexRuntimeError(input.threadId, "mcpServer/oauth/login", cause),
              ),
            ),
        ),
      ),
  } satisfies ProviderExtensionMcpFacet;

  function handleExtensionRuntimeEvent(event: ProviderEvent): Effect.Effect<void> {
    return Effect.gen(function* () {
      const context = sessions.get(event.threadId);
      if (!context || context.stopped) {
        return;
      }

      if (event.method === "skills/changed") {
        const key = cacheKey(context.cwd);
        skillInventoryCache.cache.delete(key);
        yield* PubSub.publish(extensionEvents, {
          type: "inventory.invalidated",
          threadId: context.threadId,
          cwd: context.cwd,
          domain: "skills",
        });
        yield* readSkillInventory({
          threadId: context.threadId,
          cwd: context.cwd,
          forceReload: true,
        }).pipe(
          Effect.flatMap((inventory) =>
            PubSub.publish(extensionEvents, {
              type: "inventory.updated",
              threadId: context.threadId,
              cwd: context.cwd,
              domain: "skills",
              revision: inventory.revision,
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to refresh Codex skills after invalidation.", {
              threadId: context.threadId,
              cwd: context.cwd,
              cause,
            }),
          ),
        );
        return;
      }

      const startup =
        event.method === "mcpServer/startupStatus/updated"
          ? readPayload(EffectCodexSchema.V2McpServerStatusUpdatedNotification, event.payload)
          : undefined;
      const oauth =
        event.method === "mcpServer/oauthLogin/completed"
          ? readPayload(EffectCodexSchema.V2McpServerOauthLoginCompletedNotification, event.payload)
          : undefined;
      if (!startup && !oauth) {
        return;
      }

      const name = startup?.name ?? oauth!.name;
      const threadStatuses = mcpNotificationStatus.get(context.threadId) ?? new Map();
      const previous = threadStatuses.get(name) ?? {};
      const { error: _previousError, ...previousWithoutError } = previous;
      threadStatuses.set(
        name,
        startup
          ? {
              ...previousWithoutError,
              startupStatus: startup.status,
              ...(startup.error ? { error: startup.error } : {}),
              ...(startup.failureReason === "reauthenticationRequired"
                ? { authStatus: "needs-auth" as const }
                : {}),
            }
          : {
              ...previousWithoutError,
              authStatus: oauth!.success ? "authenticated" : "needs-auth",
              ...(oauth!.error ? { error: oauth!.error } : {}),
            },
      );
      mcpNotificationStatus.set(context.threadId, threadStatuses);
      const revision = ++inventoryRevision;
      mcpNotificationRevision.set(context.threadId, revision);
      yield* PubSub.publish(extensionEvents, {
        type: "mcp.status.changed",
        threadId: context.threadId,
        cwd: context.cwd,
        mcpServerId: ProviderExtensionItemId.make(name),
        revision,
      });
    });
  }

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    input: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    return {
      type: "image" as const,
      url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  });

  const validateSelectedSkills = Effect.fn("CodexAdapter.validateSelectedSkills")(function* (
    input: ProviderSendTurnInput,
    session: CodexAdapterSessionContext,
  ) {
    if (!input.selectedSkills || input.selectedSkills.length === 0) {
      return [];
    }
    const inventory = yield* readSkillInventory({
      threadId: input.threadId,
      cwd: session.cwd,
      forceReload: true,
    });
    const desired = desiredExtensionOverrides.get(input.threadId);
    return yield* Effect.forEach(input.selectedSkills, (selected) => {
      const skill = inventory.items.find((candidate) => candidate.id === selected.id);
      if (!skill) {
        return Effect.fail(
          new ProviderAdapterStaleSkillSelectionError({
            provider: PROVIDER,
            threadId: input.threadId,
            skillId: selected.id,
            skillName: selected.name,
            reason: "missing",
          }),
        );
      }
      if (
        skill.name !== selected.name ||
        !skill.path ||
        (selected.path !== undefined && selected.path !== skill.path)
      ) {
        return Effect.fail(
          new ProviderAdapterStaleSkillSelectionError({
            provider: PROVIDER,
            threadId: input.threadId,
            skillId: selected.id,
            skillName: selected.name,
            reason: "identity-mismatch",
          }),
        );
      }
      const override = desired?.skillOverrides[selected.id];
      const effectiveEnabled =
        override === "enabled" || (override === undefined && skill.providerEnabled);
      if (!effectiveEnabled) {
        return Effect.fail(
          new ProviderAdapterStaleSkillSelectionError({
            provider: PROVIDER,
            threadId: input.threadId,
            skillId: selected.id,
            skillName: selected.name,
            reason: "disabled",
          }),
        );
      }
      return Effect.succeed({ name: skill.name, path: skill.path });
    });
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const codexAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment(input, attachment),
      { concurrency: 1 },
    );

    const session = yield* requireSession(input.threadId);
    const selectedSkills = yield* validateSelectedSkills(input, session);
    const reasoningEffort =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
        : undefined;
    const serviceTier =
      input.modelSelection?.instanceId === boundInstanceId
        ? getCodexServiceTierOptionValue(input.modelSelection)
        : undefined;
    return yield* session.runtime
      .sendTurn({
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        ...(reasoningEffort
          ? {
              effort: reasoningEffort as EffectCodexSchema.V2TurnStartParams__ReasoningEffort,
            }
          : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
        ...(selectedSkills.length > 0 ? { selectedSkills } : {}),
      })
      .pipe(Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/start", cause)));
  });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.stopped || !session.started) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return session;
  });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.interruptTurn(turnId)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "turn/interrupt", cause),
      ),
    );

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.readThread),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/read", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.rollbackThread(numTurns)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/rollback", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToRequest(requestId, decision)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/requestApproval/decision", cause),
      ),
    );

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToUserInput(requestId, answers)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/tool/requestUserInput", cause),
      ),
    );

  const writeNativeEvent = Effect.fnUntraced(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    session: CodexAdapterSessionContext,
  ) {
    if (session.stopped) {
      return;
    }
    session.stopped = true;
    sessions.delete(session.threadId);
    mcpStatusCache.cache.delete(session.threadId);
    mcpNotificationStatus.delete(session.threadId);
    mcpNotificationRevision.delete(session.threadId);
    yield* session.runtime.close.pipe(Effect.ignore);
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
  });

  const reconcileOverrides: NonNullable<ProviderExtensionsShape["reconcileOverrides"]> = Effect.fn(
    "CodexAdapter.reconcileOverrides",
  )(function* (input) {
    const current = reconciliationState(input.threadId);
    if (
      input.extensionOverridesRevision === current.appliedOverrideRevision &&
      current.pendingOverrideRevision === undefined &&
      current.error === undefined
    ) {
      return { state: current };
    }

    const pendingState = yield* publishReconciliationState(input, {
      appliedOverrideRevision: current.appliedOverrideRevision,
      pendingOverrideRevision: input.extensionOverridesRevision,
    });
    if (input.defer === true) {
      return { state: pendingState };
    }

    const context = sessions.get(input.threadId);
    if (!context || context.stopped || !context.started) {
      const state = yield* publishReconciliationState(input, {
        appliedOverrideRevision: input.extensionOverridesRevision,
      });
      return { state };
    }

    const previousSession = yield* context.runtime.getSession;
    const result = yield* startSession({
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      cwd: input.cwd,
      runtimeMode: input.runtimeMode ?? previousSession.runtimeMode,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(previousSession.resumeCursor !== undefined
        ? { resumeCursor: previousSession.resumeCursor }
        : {}),
      extensionOverrides: {
        skills: input.skillOverrides,
        mcp: input.mcpOverrides,
        revision: input.extensionOverridesRevision,
      },
    }).pipe(
      Effect.tapError((error) => {
        const failedState = reconciliationState(input.threadId);
        return failedState.pendingOverrideRevision === input.extensionOverridesRevision &&
          failedState.error !== undefined
          ? Effect.void
          : publishReconciliationState(input, {
              appliedOverrideRevision: current.appliedOverrideRevision,
              pendingOverrideRevision: input.extensionOverridesRevision,
              error: {
                domain: "all",
                message: error.message,
                retryable: true,
              },
            }).pipe(Effect.ignore);
      }),
    );
    return {
      state: reconciliationState(input.threadId),
      session: result,
    };
  });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return;
      }
      yield* stopSessionInternal(session);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter((session) => !session.stopped && session.started),
      (session) => session.runtime.getSession,
      { concurrency: 1 },
    );

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(
      Boolean(
        sessions.get(threadId) &&
        !sessions.get(threadId)?.stopped &&
        sessions.get(threadId)?.started,
      ),
    );

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(PubSub.shutdown(extensionEvents)),
      Effect.andThen(managedNativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
    extensions: {
      capabilities: CODEX_EXTENSION_CAPABILITIES,
      skills: skillsFacet,
      mcp: mcpFacet,
      reconcileOverrides,
      reconciliationState: (threadId) => Effect.succeed(reconciliationState(threadId)),
      get events() {
        return Stream.fromPubSub(extensionEvents);
      },
    } satisfies ProviderExtensionsShape,
  } satisfies CodexAdapterShape & { readonly extensions: ProviderExtensionsShape };
});

// NOTE: the old `CodexAdapterLive` / `makeCodexAdapterLive` singleton Layer
// exports have been removed as part of the per-instance-driver refactor.
// `makeCodexAdapter(codexConfig, options?)` is now invoked directly by
// `CodexDriver.create()` for each configured instance; downstream consumers
// (server bootstrap, integration harness, this module's tests) will be
// migrated to the registry in a follow-up pass.
