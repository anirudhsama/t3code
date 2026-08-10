import {
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ProviderExtensionCapabilities,
  type ProviderInstanceId,
  type ProviderMcpServer,
  type ProviderSkill,
  type RuntimeMode,
  ThreadExtensionsRpcError,
  type ThreadExtensionsSnapshot,
  type ThreadExtensionsSnapshotError,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderMcpAuthError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import {
  ThreadExtensions,
  type ProviderExtensionInventoryResult,
  type ProviderExtensionRuntimeContext,
  type ProviderMcpInventoryItem,
  type ProviderSkillInventoryItem,
  type ThreadExtensionsShape,
} from "../Services/ThreadExtensions.ts";

const UNSUPPORTED_CAPABILITIES: ProviderExtensionCapabilities = {
  skills: { inventory: false, refresh: false, threadOverride: false },
  mcp: {
    inventory: false,
    liveStatus: false,
    threadOverride: false,
    reconnect: false,
    authenticate: false,
  },
};

interface ResolvedThreadExtensionContext {
  readonly threadId: ThreadId;
  readonly projectId: OrchestrationThread["projectId"];
  readonly cwd: string;
  readonly instance: ProviderInstance;
  readonly runtime: ProviderExtensionRuntimeContext;
  readonly thread: Pick<
    OrchestrationThread,
    "skillOverrides" | "mcpOverrides" | "extensionOverridesRevision"
  >;
  readonly hasActiveSession: boolean;
}

interface RawInventorySnapshot {
  readonly skills: ProviderExtensionInventoryResult<ProviderSkillInventoryItem> | undefined;
  readonly mcp: ProviderExtensionInventoryResult<ProviderMcpInventoryItem> | undefined;
  readonly errors: ReadonlyArray<ThreadExtensionsSnapshotError>;
}

type InventoryLoadResult<Item> =
  | { readonly ok: true; readonly value: ProviderExtensionInventoryResult<Item> }
  | { readonly ok: false; readonly cause: string }
  | undefined;

const relevantThreadEvent = (
  threadId: ThreadId,
  projectId: OrchestrationThread["projectId"],
  event: OrchestrationEvent,
): boolean =>
  (event.aggregateKind === "thread" &&
    event.aggregateId === threadId &&
    (event.type === "thread.skill-override-set" ||
      event.type === "thread.mcp-override-set" ||
      event.type === "thread.meta-updated" ||
      event.type === "thread.runtime-mode-set" ||
      event.type === "thread.session-set" ||
      event.type === "thread.deleted")) ||
  (event.aggregateKind === "project" &&
    event.aggregateId === projectId &&
    (event.type === "project.meta-updated" || event.type === "project.deleted"));

const rpcError = (
  reason: ThreadExtensionsRpcError["reason"],
  message: string,
  options?: { readonly retryable?: boolean; readonly cause?: unknown },
) =>
  new ThreadExtensionsRpcError({
    reason,
    message,
    retryable: options?.retryable ?? false,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

const snapshotError = (
  domain: ThreadExtensionsSnapshotError["domain"],
  message: string,
  retryable = true,
): ThreadExtensionsSnapshotError => ({ domain, message, retryable });

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
const isProviderMcpAuthError = Schema.is(ProviderMcpAuthError);

const mapMcpAuthError = (
  cause: ProviderAdapterError,
  fallback: string,
): ThreadExtensionsRpcError => {
  if (isProviderMcpAuthError(cause)) {
    return rpcError(
      cause.reason === "invalid-callback"
        ? "invalid-callback"
        : cause.reason === "duplicate-pending" ||
            cause.reason === "no-pending" ||
            cause.reason === "already-completed"
          ? "invalid-state"
          : "provider-failed",
      cause.detail,
      { retryable: cause.retryable },
    );
  }
  return rpcError("provider-failed", fallback, { retryable: true, cause });
};

const applySkillOverrides = (
  items: ReadonlyArray<ProviderSkillInventoryItem>,
  overrides: OrchestrationThread["skillOverrides"],
): ReadonlyArray<ProviderSkill> =>
  items.map((item) => {
    const threadOverride = overrides[item.id] ?? "inherit";
    return {
      ...item,
      threadOverride,
      effectiveEnabled:
        threadOverride === "enabled" || (threadOverride === "inherit" && item.providerEnabled),
    };
  });

const applyMcpOverrides = (
  items: ReadonlyArray<ProviderMcpInventoryItem>,
  overrides: OrchestrationThread["mcpOverrides"],
): ReadonlyArray<ProviderMcpServer> =>
  items.map((item) => {
    if (item.managed || item.id === "t3-code") {
      return {
        ...item,
        threadOverride: "inherit",
        effectiveEnabled: true,
        toggleable: false,
      };
    }
    const threadOverride = overrides[item.id] ?? "inherit";
    return {
      ...item,
      threadOverride,
      effectiveEnabled:
        threadOverride === "enabled" || (threadOverride === "inherit" && item.providerEnabled),
    };
  });

export const makeThreadExtensions = Effect.fn("makeThreadExtensions")(
  function* (): Effect.fn.Return<
    ThreadExtensionsShape,
    never,
    | FileSystem.FileSystem
    | ProjectionSnapshotQuery.ProjectionSnapshotQuery
    | OrchestrationEngine.OrchestrationEngineService
    | ProviderInstanceRegistry.ProviderInstanceRegistry
    | ProviderService.ProviderService
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providerService = yield* ProviderService.ProviderService;
    const inventoryRevisions = new WeakMap<ProviderInstance, Map<string, number>>();
    let nextInventoryRevision = 0;
    let nextSnapshotRequestId = 0;
    const snapshotRequestLanes = new Map<
      string,
      {
        latestId: number;
        latest: Deferred.Deferred<ThreadExtensionsSnapshot, ThreadExtensionsRpcError>;
        active: number;
      }
    >();

    const canonicalizeCwd = Effect.fn("ThreadExtensions.canonicalizeCwd")(function* (cwd: string) {
      return yield* fileSystem
        .realPath(cwd)
        .pipe(
          Effect.mapError((cause) =>
            rpcError("invalid-state", `Could not resolve workspace directory '${cwd}'.`, { cause }),
          ),
        );
    });

    const requireInstance = Effect.fn("ThreadExtensions.requireInstance")(function* (
      providerInstanceId: ProviderInstanceId,
    ) {
      const instance = yield* instances.getInstance(providerInstanceId);
      if (!instance || !instance.enabled) {
        return yield* rpcError(
          "provider-unavailable",
          `Provider instance '${providerInstanceId}' is unavailable.`,
          { retryable: true },
        );
      }
      return instance;
    });

    const resolveProjectCwd = Effect.fn("ThreadExtensions.resolveProjectCwd")(function* (
      project: OrchestrationProjectShell,
    ) {
      return yield* canonicalizeCwd(project.workspaceRoot);
    });

    const resolveThreadContext = Effect.fn("ThreadExtensions.resolveThreadContext")(function* (
      threadId: ThreadId,
    ) {
      const threadOption = yield* projection.getThreadDetailById(threadId).pipe(
        Effect.mapError((cause) =>
          rpcError("provider-failed", `Could not load thread '${threadId}'.`, {
            retryable: true,
            cause,
          }),
        ),
      );
      if (Option.isNone(threadOption)) {
        return yield* rpcError("thread-not-found", `Thread '${threadId}' was not found.`);
      }
      const thread = threadOption.value;
      const projectOption = yield* projection.getProjectShellById(thread.projectId).pipe(
        Effect.mapError((cause) =>
          rpcError("provider-failed", `Could not load project '${thread.projectId}'.`, {
            retryable: true,
            cause,
          }),
        ),
      );
      if (Option.isNone(projectOption)) {
        return yield* rpcError(
          "invalid-state",
          `Thread '${threadId}' does not have an active project.`,
        );
      }
      const rawCwd = resolveThreadWorkspaceCwd({ thread, projects: [projectOption.value] });
      if (!rawCwd) {
        return yield* rpcError(
          "invalid-state",
          `Thread '${threadId}' does not have a workspace directory.`,
        );
      }
      const activeSession = (yield* providerService.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      const providerInstanceId =
        activeSession?.providerInstanceId ??
        thread.session?.providerInstanceId ??
        thread.modelSelection.instanceId;
      const instance = yield* requireInstance(providerInstanceId);
      const cwd = yield* canonicalizeCwd(rawCwd);
      const modelSelection: ModelSelection =
        activeSession?.model === undefined
          ? thread.modelSelection
          : {
              ...thread.modelSelection,
              instanceId: providerInstanceId,
              model: activeSession.model,
            };
      const runtimeMode: RuntimeMode = activeSession?.runtimeMode ?? thread.runtimeMode;
      return {
        threadId,
        projectId: thread.projectId,
        cwd,
        instance,
        runtime: {
          threadId,
          cwd,
          runtimeMode,
          modelSelection,
          ...(activeSession?.resumeCursor === undefined
            ? {}
            : { resumeCursor: activeSession.resumeCursor }),
        },
        thread,
        hasActiveSession: activeSession !== undefined,
      } satisfies ResolvedThreadExtensionContext;
    });

    const resolvePreviewContext = Effect.fn("ThreadExtensions.resolvePreviewContext")(function* (
      input: Parameters<ThreadExtensionsShape["previewSnapshot"]>[0],
    ) {
      const existingThread = yield* projection.getThreadDetailById(input.threadId).pipe(
        Effect.mapError((cause) =>
          rpcError("provider-failed", `Could not validate pending thread '${input.threadId}'.`, {
            retryable: true,
            cause,
          }),
        ),
      );
      if (Option.isSome(existingThread)) {
        return yield* rpcError(
          "invalid-state",
          `Thread '${input.threadId}' already exists; use the thread snapshot endpoint.`,
        );
      }
      const projectOption = yield* projection.getProjectShellById(input.projectId).pipe(
        Effect.mapError((cause) =>
          rpcError("provider-failed", `Could not load project '${input.projectId}'.`, {
            retryable: true,
            cause,
          }),
        ),
      );
      if (Option.isNone(projectOption)) {
        return yield* rpcError("invalid-state", `Project '${input.projectId}' was not found.`);
      }
      const instance = yield* requireInstance(input.providerInstanceId);
      const cwd = yield* resolveProjectCwd(projectOption.value);
      const modelSelection =
        projectOption.value.defaultModelSelection?.instanceId === input.providerInstanceId
          ? projectOption.value.defaultModelSelection
          : undefined;
      return {
        threadId: input.threadId,
        projectId: input.projectId,
        cwd,
        instance,
        runtime: {
          threadId: input.threadId,
          cwd,
          ...(modelSelection ? { modelSelection } : {}),
        },
        thread: {
          skillOverrides: {},
          mcpOverrides: {},
          extensionOverridesRevision: 0,
        },
        hasActiveSession: false,
      } satisfies ResolvedThreadExtensionContext;
    });

    const loadRawInventory = Effect.fn("ThreadExtensions.loadRawInventory")(function* (
      context: ResolvedThreadExtensionContext,
      options?: { readonly refreshDomain?: "skills" | "mcp" | "all" },
    ) {
      const extensions = context.instance.extensions;
      if (!extensions) {
        return { skills: undefined, mcp: undefined, errors: [] } satisfies RawInventorySnapshot;
      }
      const refreshDomain = options?.refreshDomain;
      const readSkills =
        refreshDomain === "skills" || refreshDomain === "all"
          ? extensions.skills?.refresh
          : extensions.skills?.inventory;
      const readMcp =
        refreshDomain === "mcp" || refreshDomain === "all"
          ? extensions.mcp?.refresh
          : extensions.mcp?.inventory;
      const load = <Item>(
        read:
          | ((
              input: ProviderExtensionRuntimeContext,
            ) => Effect.Effect<ProviderExtensionInventoryResult<Item>, ProviderAdapterError>)
          | undefined,
      ): Effect.Effect<InventoryLoadResult<Item>> =>
        read
          ? read(context.runtime).pipe(
              Effect.map((value) => ({ ok: true as const, value })),
              Effect.catch((cause) =>
                Effect.succeed({ ok: false as const, cause: errorMessage(cause) }),
              ),
            )
          : Effect.sync(() => undefined);
      const [skillsResult, mcpResult] = yield* Effect.all(
        [load<ProviderSkillInventoryItem>(readSkills), load<ProviderMcpInventoryItem>(readMcp)],
        { concurrency: "unbounded" },
      );
      const errors: Array<ThreadExtensionsSnapshotError> = [];
      if (skillsResult && !skillsResult.ok) {
        errors.push(snapshotError("skills", skillsResult.cause));
      }
      if (mcpResult && !mcpResult.ok) {
        errors.push(snapshotError("mcp", mcpResult.cause));
      }
      const skills = skillsResult?.ok ? skillsResult.value : undefined;
      const mcp = mcpResult?.ok ? mcpResult.value : undefined;
      errors.push(...(skills?.warnings ?? []).map((message) => snapshotError("skills", message)));
      errors.push(...(mcp?.warnings ?? []).map((message) => snapshotError("mcp", message)));
      return { skills, mcp, errors } satisfies RawInventorySnapshot;
    });

    const inventoryRevision = (
      instance: ProviderInstance,
      inventory: RawInventorySnapshot,
    ): number => {
      if (!instance.extensions) {
        return 0;
      }
      let revisions = inventoryRevisions.get(instance);
      if (!revisions) {
        revisions = new Map();
        inventoryRevisions.set(instance, revisions);
      }
      const key = `${inventory.skills?.revision ?? 0}:${inventory.mcp?.revision ?? 0}`;
      const existing = revisions.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const revision = ++nextInventoryRevision;
      revisions.set(key, revision);
      return revision;
    };

    const buildSnapshot = Effect.fn("ThreadExtensions.buildSnapshot")(function* (
      context: ResolvedThreadExtensionContext,
      options?: { readonly refreshDomain?: "skills" | "mcp" | "all" },
    ) {
      const inventory = yield* loadRawInventory(context, options);
      const errors = [...inventory.errors];
      let appliedOverrideRevision = context.thread.extensionOverridesRevision;
      if (context.instance.extensions?.reconciliationState) {
        const reconciliation = yield* context.instance.extensions.reconciliationState(
          context.threadId,
        );
        const reconciliationIsRelevant =
          context.hasActiveSession ||
          reconciliation.pendingOverrideRevision !== undefined ||
          reconciliation.error !== undefined;
        if (reconciliationIsRelevant) {
          appliedOverrideRevision = reconciliation.appliedOverrideRevision;
        }
        if (reconciliationIsRelevant && reconciliation.error) {
          errors.push(
            snapshotError(
              reconciliation.error.domain,
              reconciliation.error.message,
              reconciliation.error.retryable,
            ),
          );
        }
      }
      const refreshedAt = context.instance.extensions
        ? DateTime.formatIso(yield* DateTime.now)
        : null;
      return {
        threadId: context.threadId,
        providerInstanceId: context.instance.instanceId,
        provider: context.instance.driverKind,
        cwd: context.cwd,
        capabilities: context.instance.extensions?.capabilities ?? UNSUPPORTED_CAPABILITIES,
        skills: applySkillOverrides(inventory.skills?.items ?? [], context.thread.skillOverrides),
        mcpServers: applyMcpOverrides(inventory.mcp?.items ?? [], context.thread.mcpOverrides),
        inventoryRevision: inventoryRevision(context.instance, inventory),
        overrideRevision: context.thread.extensionOverridesRevision,
        appliedOverrideRevision,
        loading: { skills: false, mcp: false },
        errors,
        refreshedAt,
      } satisfies ThreadExtensionsSnapshot;
    });

    const protectSnapshot = Effect.fn("ThreadExtensions.protectSnapshot")(function* (
      key: string,
      load: Effect.Effect<ThreadExtensionsSnapshot, ThreadExtensionsRpcError>,
    ) {
      const deferred = yield* Deferred.make<ThreadExtensionsSnapshot, ThreadExtensionsRpcError>();
      const requestId = ++nextSnapshotRequestId;
      const lane = snapshotRequestLanes.get(key) ?? {
        latestId: requestId,
        latest: deferred,
        active: 0,
      };
      lane.latestId = requestId;
      lane.latest = deferred;
      lane.active += 1;
      snapshotRequestLanes.set(key, lane);
      const loaded = yield* Effect.exit(load);
      if (lane.latestId !== requestId) {
        const latestResult = yield* Effect.exit(Deferred.await(lane.latest));
        yield* Deferred.done(deferred, latestResult);
        lane.active -= 1;
        if (lane.active === 0) snapshotRequestLanes.delete(key);
        return yield* latestResult;
      }
      yield* Deferred.done(deferred, loaded);
      lane.active -= 1;
      if (lane.active === 0) snapshotRequestLanes.delete(key);
      return yield* loaded;
    });

    const snapshot: ThreadExtensionsShape["snapshot"] = (input) =>
      protectSnapshot(
        `thread:${input.threadId}`,
        resolveThreadContext(input.threadId).pipe(
          Effect.flatMap((context) => buildSnapshot(context)),
        ),
      );

    const previewSnapshot: ThreadExtensionsShape["previewSnapshot"] = (input) =>
      protectSnapshot(
        `preview:${input.threadId}`,
        resolvePreviewContext(input).pipe(Effect.flatMap((context) => buildSnapshot(context))),
      );

    const refresh: ThreadExtensionsShape["refresh"] = (input) =>
      protectSnapshot(
        `thread:${input.threadId}`,
        resolveThreadContext(input.threadId).pipe(
          Effect.flatMap((context) =>
            buildSnapshot(context, { refreshDomain: input.domain ?? "all" }),
          ),
        ),
      );

    const refreshPreview: ThreadExtensionsShape["refreshPreview"] = (input) =>
      protectSnapshot(
        `preview:${input.threadId}`,
        resolvePreviewContext(input).pipe(
          Effect.flatMap((context) =>
            buildSnapshot(context, { refreshDomain: input.domain ?? "all" }),
          ),
        ),
      );

    const events: ThreadExtensionsShape["events"] = (input) => {
      return Stream.unwrap(
        resolveThreadContext(input.threadId).pipe(
          Effect.map((initialContext) => {
            const orchestrationTriggers = orchestration.streamDomainEvents.pipe(
              Stream.filter((event) =>
                relevantThreadEvent(input.threadId, initialContext.projectId, event),
              ),
              Stream.map(() => undefined),
            );
            const contexts = Stream.concat(
              Stream.make(initialContext),
              instances.streamChanges.pipe(
                Stream.mapEffect(() => resolveThreadContext(input.threadId)),
              ),
            );
            const providerTriggers = contexts.pipe(
              Stream.switchMap((context) =>
                Stream.merge(
                  Stream.make(undefined),
                  context.instance.extensions
                    ? context.instance.extensions.events.pipe(
                        Stream.filter((event) => event.threadId === input.threadId),
                        Stream.map(() => undefined),
                      )
                    : Stream.empty,
                ),
              ),
            );
            return Stream.merge(providerTriggers, orchestrationTriggers).pipe(
              Stream.mapEffect(() => snapshot(input)),
            );
          }),
        ),
      );
    };

    const previewEvents: ThreadExtensionsShape["previewEvents"] = (input) =>
      Stream.unwrap(
        resolvePreviewContext(input).pipe(
          Effect.map((context) =>
            Stream.merge(
              Stream.make(undefined),
              context.instance.extensions
                ? context.instance.extensions.events.pipe(
                    Stream.filter((event) => event.threadId === input.threadId),
                    Stream.map(() => undefined),
                  )
                : Stream.empty,
            ).pipe(Stream.mapEffect(() => previewSnapshot(input))),
          ),
        ),
      );

    const reconnectMcp: NonNullable<ThreadExtensionsShape["reconnectMcp"]> = Effect.fn(
      "ThreadExtensions.reconnectMcp",
    )(function* (input) {
      const context = yield* resolveThreadContext(input.threadId);
      const reconnect = context.instance.extensions?.mcp?.reconnect;
      if (!reconnect) {
        return yield* rpcError("unsupported", "This provider does not support MCP reconnect.");
      }
      yield* reconnect({ ...context.runtime, mcpServerId: input.mcpServerId }).pipe(
        Effect.mapError((cause) =>
          rpcError("provider-failed", `Could not reconnect MCP server '${input.mcpServerId}'.`, {
            retryable: true,
            cause,
          }),
        ),
      );
      return yield* snapshot({ threadId: input.threadId });
    });

    const beginMcpAuth: NonNullable<ThreadExtensionsShape["beginMcpAuth"]> = Effect.fn(
      "ThreadExtensions.beginMcpAuth",
    )(function* (input) {
      const context =
        input.projectId === undefined || input.providerInstanceId === undefined
          ? yield* resolveThreadContext(input.threadId)
          : yield* resolvePreviewContext({
              threadId: input.threadId,
              projectId: input.projectId,
              providerInstanceId: input.providerInstanceId,
            });
      const authenticate = context.instance.extensions?.mcp?.authenticate;
      if (!authenticate) {
        return yield* rpcError("unsupported", "This provider does not support MCP authentication.");
      }
      const result = yield* authenticate({
        ...context.runtime,
        mcpServerId: input.mcpServerId,
      }).pipe(
        Effect.mapError((cause) =>
          mapMcpAuthError(
            cause,
            `Could not begin authentication for MCP server '${input.mcpServerId}'.`,
          ),
        ),
      );
      return {
        snapshot:
          input.projectId === undefined || input.providerInstanceId === undefined
            ? yield* snapshot({ threadId: input.threadId })
            : yield* previewSnapshot({
                threadId: input.threadId,
                projectId: input.projectId,
                providerInstanceId: input.providerInstanceId,
              }),
        authorizationUrl: result.authorizationUrl,
      };
    });

    const relayMcpAuthCallback: NonNullable<ThreadExtensionsShape["relayMcpAuthCallback"]> =
      Effect.fn("ThreadExtensions.relayMcpAuthCallback")(function* (input) {
        const preview = input.projectId !== undefined && input.providerInstanceId !== undefined;
        const context = preview
          ? yield* resolvePreviewContext({
              threadId: input.threadId,
              projectId: input.projectId,
              providerInstanceId: input.providerInstanceId,
            })
          : yield* resolveThreadContext(input.threadId);
        const relay = context.instance.extensions?.mcp?.relayAuthenticationCallback;
        if (!relay) {
          return yield* rpcError(
            "unsupported",
            "This provider does not support remote MCP authentication callbacks.",
          );
        }
        yield* relay({
          ...context.runtime,
          mcpServerId: input.mcpServerId,
          callbackUrl: input.callbackUrl,
        }).pipe(
          Effect.mapError((cause) =>
            mapMcpAuthError(
              cause,
              `Could not deliver the authentication callback for MCP server '${input.mcpServerId}'.`,
            ),
          ),
        );
        return preview
          ? yield* previewSnapshot({
              threadId: input.threadId,
              projectId: input.projectId,
              providerInstanceId: input.providerInstanceId,
            })
          : yield* snapshot({ threadId: input.threadId });
      });

    return ThreadExtensions.of({
      snapshot,
      previewSnapshot,
      refresh,
      refreshPreview,
      events,
      previewEvents,
      reconnectMcp,
      beginMcpAuth,
      relayMcpAuthCallback,
    });
  },
);

export const ThreadExtensionsLive = Layer.effect(ThreadExtensions, makeThreadExtensions());
