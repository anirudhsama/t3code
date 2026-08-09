// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ApprovalRequestId,
  CodexSettings,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderExtensionItemId,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterStaleSkillSelectionError,
  ProviderAdapterValidationError,
  ProviderMcpAuthError,
} from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderExtensionsShape } from "../Services/ThreadExtensions.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeStartInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import {
  CODEX_EXTENSION_CAPABILITIES,
  compileCodexExtensionConfig,
  makeCodexAdapter,
  matchesMcpOAuthCallbackTarget,
  parseCodexMcpDefinitions,
  parseMcpOAuthCallbackTarget,
  relayMcpOAuthCallbackRequest,
} from "./CodexAdapter.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const isProviderAdapterStaleSkillSelectionError = Schema.is(
  ProviderAdapterStaleSkillSelectionError,
);

// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "t3/provider/Layers/CodexAdapter.test/CodexAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";

  public readonly startImpl = vi.fn((_input?: CodexSessionRuntimeStartInput) =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );

  public readonly interruptTurnImpl = vi.fn(
    (_turnId?: TurnId): Promise<void> => Promise.resolve(undefined),
  );

  public readonly readThreadImpl = vi.fn(
    (): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly rollbackThreadImpl = vi.fn(
    (_numTurns: number): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  public readonly listSkillsImpl = vi.fn(
    (input: {
      readonly cwd: string;
      readonly forceReload?: boolean;
    }): Promise<EffectCodexSchema.V2SkillsListResponse> =>
      Promise.resolve({
        data: [{ cwd: input.cwd, skills: [], errors: [] }],
      }),
  );

  public readonly readMcpConfigImpl = vi.fn(
    (_cwd: string): Promise<EffectCodexSchema.V2ConfigReadResponse> =>
      Promise.resolve({
        config: {},
        origins: {},
        layers: [],
      }),
  );

  public readonly listMcpServerStatusImpl = vi.fn(
    (): Promise<EffectCodexSchema.V2ListMcpServerStatusResponse> =>
      Promise.resolve({
        data: [],
        nextCursor: null,
      }),
  );

  public readonly beginMcpAuthImpl = vi.fn((_name: string) =>
    Promise.resolve({ authorizationUrl: "https://example.test/authorize" }),
  );

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  initialize = Effect.void;

  start(input?: CodexSessionRuntimeStartInput) {
    return Effect.promise(() => this.startImpl(input));
  }

  listSkills(input: { readonly cwd: string; readonly forceReload?: boolean }) {
    return Effect.promise(() => this.listSkillsImpl(input));
  }

  readMcpConfig(cwd: string) {
    return Effect.promise(() => this.readMcpConfigImpl(cwd));
  }

  listMcpServerStatus = Effect.tryPromise({
    try: () => this.listMcpServerStatusImpl(),
    catch: (cause) =>
      new CodexErrors.CodexAppServerTransportError({
        operation: "read-input-stream",
        cause,
      }),
  });

  beginMcpAuth(name: string) {
    return Effect.promise(() => this.beginMcpAuthImpl(name));
  }

  getSession = Effect.promise(() => this.startImpl());

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  interruptTurn(turnId?: TurnId) {
    return Effect.promise(() => this.interruptTurnImpl(turnId));
  }

  readThread = Effect.promise(() => this.readThreadImpl());

  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

function makeRuntimeFactory(configure?: (runtime: FakeCodexRuntime) => void) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    configure?.(runtime);
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });

  return {
    factory,
    runtimes,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );

      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }

      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const validationRuntimeFactory = makeRuntimeFactory();
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      NodeAssert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "serviceTier", value: "priority" },
        ]),
        runtimeMode: "full-access",
      });

      NodeAssert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0], {
        binaryPath: "codex",
        cwd: process.cwd(),
        launchArgs: "",
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "priority",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
    }),
  );
});

const sessionRuntimeFactory = makeRuntimeFactory();
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps missing adapter sessions to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "codex");
      NodeAssert.equal(result.failure.threadId, "sess-missing");
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ]),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
      });
    }),
  );

  it.effect("passes configured launch args into the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--strict-config --enable foo" });
        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable foo");
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses T3CODE_CODEX_LAUNCH_ARGS for the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--enable settings-feature" });
        return yield* makeCodexAdapter(codexConfig, {
          environment: { T3CODE_CODEX_LAUNCH_ARGS: " --strict-config --enable env-feature " },
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args-env"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable env-feature");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps codex model options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const customRuntimeFactory = makeRuntimeFactory();
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-custom-instance"),
        runtimeMode: "full-access",
      });
      const runtime = customRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-custom-instance"),
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex_personal"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "flex" },
            ],
          ),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "flex",
      });
    }).pipe(Effect.provide(customLayer));
  });
});

const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function startLifecycleRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    return { adapter, runtime };
  });
}

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "done",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.itemId, "msg_1");
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("labels MCP lifecycle entries with server and tool names", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-mcp-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("mcp_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "mcp_1",
            server: "t3-code",
            tool: "preview_status",
            arguments: {},
            durationMs: 12,
            error: null,
            result: { content: [{ type: "text", text: "attached" }] },
            status: "completed",
          },
        },
      });
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.itemType, "mcp_tool_call");
      NodeAssert.equal(firstEvent.value.payload.title, "t3-code · preview_status");
      NodeAssert.deepStrictEqual(firstEvent.value.payload.data, {
        completedAtMs: 1_778_000_000_000,
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "t3-code",
          tool: "preview_status",
          arguments: {},
          durationMs: 12,
          error: null,
          result: { content: [{ type: "text", text: "attached" }] },
          status: "completed",
        },
      });
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/closed",
        message: "Session stopped",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps realtime started notifications with upstream realtime session ids", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-realtime-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/realtime/started",
        payload: {
          threadId: "thread-1",
          realtimeSessionId: "realtime-session-1",
          version: "v2",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.realtime.started");
      if (firstEvent.value.type !== "thread.realtime.started") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.realtimeSessionId, "realtime-session-1");
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.class, "provider_error");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "command",
        requestId: ApprovalRequestId.make("req-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "file-read",
        requestId: ApprovalRequestId.make("req-file-read-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-file-read-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      NodeAssert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          mode: "unelevated",
          success: false,
          error: "unsupported environment",
        },
      };

      yield* runtime.emit(event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      NodeAssert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      NodeAssert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        NodeAssert.equal(firstEvent.payload.state, "error");
        NodeAssert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      NodeAssert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        NodeAssert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            itemId: "item-user-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        NodeAssert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          NodeAssert.equal(events[0].requestId, "req-user-input-1");
          NodeAssert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          NodeAssert.equal(events[0].payload.questions[0]?.multiSelect, false);
        }

        NodeAssert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          NodeAssert.equal(events[1].requestId, "req-user-input-1");
          NodeAssert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      NodeAssert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );
});

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedLifecycleLayer("CodexAdapterLive scoped lifecycle", (it) => {
  it.effect("closes the externally owned session scope on stopSession", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-stop"),
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      yield* adapter.stopSession(asThreadId("thread-stop"));

      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1);
      NodeAssert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-stop"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-stop")), false);
    }),
  );
});

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedFailureLayer("CodexAdapterLive scoped startup failure", (it) => {
  it.effect("closes the externally owned session scope when startSession fails", () =>
    Effect.gen(function* () {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-fail"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterProcessError");
      NodeAssert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-fail"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-fail")), false);
    }),
  );
});

function withExtensionsTestAdapter<A>(
  runtimeFactory: ReturnType<typeof makeRuntimeFactory>,
  use: (
    adapter: CodexAdapterShape & { readonly extensions: ProviderExtensionsShape },
  ) => Effect.Effect<A, ProviderAdapterError, Scope.Scope>,
  options?: {
    readonly managementIdleTimeoutMs?: number;
    readonly relayMcpOAuthCallback?: (
      callbackUrl: string,
    ) => Effect.Effect<void, ProviderMcpAuthError>;
  },
) {
  return Effect.gen(function* () {
    const adapter = yield* makeCodexAdapter(decodeCodexSettings({}), {
      makeRuntime: runtimeFactory.factory,
      ...options,
    });
    return yield* use(adapter);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  );
}

it("compiles sparse Codex overrides and drops the managed t3-code MCP override", () => {
  NodeAssert.deepStrictEqual(
    compileCodexExtensionConfig({
      skillOverrides: {
        [ProviderExtensionItemId.make("/workspace/.agents/skills/review/SKILL.md")]: "disabled",
      },
      mcpOverrides: {
        [ProviderExtensionItemId.make("postgres")]: "enabled",
        [ProviderExtensionItemId.make("t3-code")]: "disabled",
      },
    }),
    {
      skills: {
        config: [
          {
            path: "/workspace/.agents/skills/review/SKILL.md",
            enabled: false,
          },
        ],
      },
      mcp_servers: {
        postgres: { enabled: true },
      },
    },
  );
});

it("accepts only the exact pending loopback callback target", () => {
  const redirectUri = "http://127.0.0.1:43123/callback/nonce";
  const target = parseMcpOAuthCallbackTarget(
    `https://provider.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
  );
  NodeAssert.ok(target);

  const cases = [
    ["http://127.0.0.1:43123/callback/nonce?code=opaque", true],
    ["https://127.0.0.1:43123/callback/nonce?code=opaque", false],
    ["http://localhost:43123/callback/nonce?code=opaque", false],
    ["http://127.0.0.2:43123/callback/nonce?code=opaque", false],
    ["http://127.0.0.1:43124/callback/nonce?code=opaque", false],
    ["http://127.0.0.1:43123/callback/other?code=opaque", false],
    ["http://user@127.0.0.1:43123/callback/nonce?code=opaque", false],
    ["http://127.0.0.1:43123/callback/nonce?code=opaque#fragment", false],
  ] as const;

  for (const [callbackUrl, expected] of cases) {
    NodeAssert.equal(matchesMcpOAuthCallbackTarget(callbackUrl, target), expected, callbackUrl);
  }
  NodeAssert.equal(
    parseMcpOAuthCallbackTarget(
      "https://provider.example/authorize?redirect_uri=https%3A%2F%2F127.0.0.1%3A43123%2Fcallback",
    ),
    null,
  );
});

it.effect("relays the original callback query without following redirects", () => {
  const calls: Array<{
    readonly input: Parameters<typeof globalThis.fetch>[0];
    readonly init: Parameters<typeof globalThis.fetch>[1];
  }> = [];
  const fetchImpl: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      calls.push({ input, init });
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://should-not-be-followed.example" },
        }),
      );
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const callbackUrl =
    "http://127.0.0.1:43123/callback/docs?code=opaque%2Fvalue&state=one&state=two";

  return relayMcpOAuthCallbackRequest(callbackUrl).pipe(
    Effect.provideService(FetchHttpClient.Fetch, fetchImpl),
    Effect.tap(() =>
      Effect.sync(() => {
        NodeAssert.equal(calls.length, 1);
        NodeAssert.equal(String(calls[0]!.input), callbackUrl);
        NodeAssert.equal(calls[0]!.init?.redirect, "manual");
      }),
    ),
  );
});

it.effect("tracks MCP OAuth begin, relay, completion, timeout, and retry", () => {
  const runtimeFactory = makeRuntimeFactory((runtime) => {
    runtime.beginMcpAuthImpl.mockImplementation((name) => {
      if (name === "unsafe") {
        return Promise.resolve({
          authorizationUrl:
            "https://provider.example/authorize?redirect_uri=https%3A%2F%2Fexample.test%2Fcallback%3Fcode%3Dauthorization-secret",
        });
      }
      const redirectUri = `http://127.0.0.1:43123/callback/${name}`;
      return Promise.resolve({
        authorizationUrl: `https://provider.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      });
    });
  });
  const relayed: Array<string> = [];
  const threadId = asThreadId("thread-mcp-oauth-relay");
  const input = {
    threadId,
    cwd: "/workspace/mcp-oauth",
    mcpServerId: ProviderExtensionItemId.make("docs"),
  } as const;

  return withExtensionsTestAdapter(
    runtimeFactory,
    (adapter) =>
      Effect.gen(function* () {
        const noPending = yield* adapter.extensions.mcp!.relayAuthenticationCallback!({
          ...input,
          callbackUrl: "http://127.0.0.1:43123/callback/docs?code=opaque",
        }).pipe(Effect.flip, Effect.orDie);
        NodeAssert.equal(noPending._tag, "ProviderMcpAuthError");
        NodeAssert.equal(noPending.reason, "no-pending");

        yield* adapter.extensions.mcp!.authenticate!(input);

        const duplicate = yield* adapter.extensions.mcp!.authenticate!(input).pipe(
          Effect.flip,
          Effect.orDie,
        );
        NodeAssert.equal(duplicate._tag, "ProviderMcpAuthError");
        NodeAssert.equal(duplicate.reason, "duplicate-pending");

        const mismatchSecret = "mismatch-secret";
        const mismatch = yield* adapter.extensions.mcp!.relayAuthenticationCallback!({
          ...input,
          callbackUrl: `http://127.0.0.1:43124/callback/docs?code=${mismatchSecret}`,
        }).pipe(Effect.flip, Effect.orDie);
        NodeAssert.equal(mismatch._tag, "ProviderMcpAuthError");
        NodeAssert.equal(mismatch.reason, "invalid-callback");
        NodeAssert.doesNotMatch(mismatch.message, new RegExp(mismatchSecret));

        const callbackUrl =
          "http://127.0.0.1:43123/callback/docs?code=opaque%2Fvalue&state=one&state=two";
        yield* adapter.extensions.mcp!.relayAuthenticationCallback!({ ...input, callbackUrl });
        NodeAssert.deepStrictEqual(relayed, [callbackUrl]);

        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        yield* runtime.emit({
          id: asEventId("evt-mcp-oauth-relay-completed"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "mcpServer/oauthLogin/completed",
          payload: { name: "docs", success: true, error: null },
        });
        yield* Effect.yieldNow;

        const completed = yield* adapter.extensions.mcp!.relayAuthenticationCallback!({
          ...input,
          callbackUrl,
        }).pipe(Effect.flip, Effect.orDie);
        NodeAssert.equal(completed._tag, "ProviderMcpAuthError");
        NodeAssert.equal(completed.reason, "already-completed");

        const timeoutInput = {
          ...input,
          mcpServerId: ProviderExtensionItemId.make("timeout"),
        };
        yield* adapter.extensions.mcp!.authenticate!(timeoutInput);
        yield* runtime.emit({
          id: asEventId("evt-mcp-oauth-timeout"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "mcpServer/oauthLogin/completed",
          payload: { name: "timeout", success: false, error: "timed out" },
        });
        yield* Effect.yieldNow;
        yield* adapter.extensions.mcp!.authenticate!(timeoutInput);
        NodeAssert.equal(
          runtime.beginMcpAuthImpl.mock.calls.filter(([name]) => name === "timeout").length,
          2,
        );

        const unsafeSecret = "authorization-secret";
        const unsafe = yield* adapter.extensions.mcp!.authenticate!({
          ...input,
          mcpServerId: ProviderExtensionItemId.make("unsafe"),
        }).pipe(Effect.flip, Effect.orDie);
        NodeAssert.equal(unsafe._tag, "ProviderMcpAuthError");
        NodeAssert.equal(unsafe.reason, "unsafe-redirect");
        NodeAssert.doesNotMatch(unsafe.message, new RegExp(unsafeSecret));
      }),
    {
      relayMcpOAuthCallback: (callbackUrl) =>
        Effect.sync(() => {
          relayed.push(callbackUrl);
        }),
    },
  );
});

it.effect("reaps a management-only runtime after its idle window", () => {
  const runtimeFactory = makeRuntimeFactory();
  const threadId = asThreadId("thread-management-idle");

  return withExtensionsTestAdapter(
    runtimeFactory,
    (adapter) =>
      Effect.gen(function* () {
        yield* adapter.extensions.skills!.inventory({
          threadId,
          cwd: "/workspace/management-idle",
        });
        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        NodeAssert.equal(runtime.closeImpl.mock.calls.length, 0);

        yield* TestClock.adjust("11 millis");
        yield* Effect.yieldNow;

        NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1);
        NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      }),
    { managementIdleTimeoutMs: 10 },
  );
});

it.effect("records overrides without starting a runtime when no session is active", () => {
  const runtimeFactory = makeRuntimeFactory();
  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      const result = yield* adapter.extensions.reconcileOverrides!({
        threadId: asThreadId("thread-stopped"),
        cwd: "/workspace",
        runtimeMode: "full-access",
        skillOverrides: {},
        mcpOverrides: { [ProviderExtensionItemId.make("postgres")]: "disabled" },
        extensionOverridesRevision: 3,
      });

      NodeAssert.equal(runtimeFactory.runtimes.length, 0);
      NodeAssert.equal(result.state.appliedOverrideRevision, 3);
      NodeAssert.equal(result.session, undefined);
    }),
  );
});

it.effect("keeps sibling override state isolated while restart-resuming one idle thread", () => {
  const runtimeFactory = makeRuntimeFactory((runtime) => {
    runtime.startImpl.mockImplementation((input) =>
      Promise.resolve({
        provider: ProviderDriverKind.make("codex"),
        status: "ready",
        runtimeMode: input?.runtimeMode ?? runtime.options.runtimeMode,
        threadId: runtime.options.threadId,
        cwd: input?.cwd ?? runtime.options.cwd,
        resumeCursor: {
          threadId: `provider-${runtime.options.threadId}`,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  });

  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      const skillId = ProviderExtensionItemId.make("/workspace/.agents/skills/review/SKILL.md");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-a"),
        cwd: "/workspace",
        runtimeMode: "full-access",
        extensionOverrides: {
          skills: { [skillId]: "disabled" },
          mcp: { [ProviderExtensionItemId.make("postgres")]: "disabled" },
          revision: 1,
        },
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-b"),
        cwd: "/workspace",
        runtimeMode: "full-access",
        extensionOverrides: {
          skills: { [skillId]: "enabled" },
          mcp: { [ProviderExtensionItemId.make("postgres")]: "enabled" },
          revision: 1,
        },
      });

      const originalA = runtimeFactory.runtimes[0]!;
      const siblingB = runtimeFactory.runtimes[1]!;
      const result = yield* adapter.extensions.reconcileOverrides!({
        threadId: asThreadId("thread-a"),
        cwd: "/workspace",
        runtimeMode: "full-access",
        skillOverrides: { [skillId]: "enabled" },
        mcpOverrides: { [ProviderExtensionItemId.make("postgres")]: "enabled" },
        extensionOverridesRevision: 2,
      });

      NodeAssert.equal(runtimeFactory.runtimes.length, 3);
      NodeAssert.equal(originalA.closeImpl.mock.calls.length, 1);
      NodeAssert.equal(siblingB.closeImpl.mock.calls.length, 0);
      NodeAssert.deepStrictEqual(runtimeFactory.runtimes[2]!.options.resumeCursor, {
        threadId: "provider-thread-a",
      });
      NodeAssert.deepStrictEqual(runtimeFactory.runtimes[2]!.options.config, {
        skills: { config: [{ path: skillId, enabled: true }] },
        mcp_servers: { postgres: { enabled: true } },
      });
      NodeAssert.equal(result.state.appliedOverrideRevision, 2);
      NodeAssert.equal(
        (yield* adapter.extensions.reconciliationState!(asThreadId("thread-b")))
          .appliedOverrideRevision,
        1,
      );
    }),
  );
});

it.effect("retains pending desired state and a retryable error when reconciliation fails", () => {
  let runtimeIndex = 0;
  const runtimeFactory = makeRuntimeFactory((runtime) => {
    runtimeIndex += 1;
    runtime.startImpl.mockImplementation((input) =>
      Promise.resolve({
        provider: ProviderDriverKind.make("codex"),
        status: "ready",
        runtimeMode: input?.runtimeMode ?? runtime.options.runtimeMode,
        threadId: runtime.options.threadId,
        cwd: input?.cwd ?? runtime.options.cwd,
        resumeCursor: { threadId: "provider-thread-failure" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    if (runtimeIndex === 2) {
      runtime.listMcpServerStatusImpl.mockRejectedValue(new Error("confirmation failed"));
    }
  });

  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-failure"),
        cwd: "/workspace",
        runtimeMode: "full-access",
        extensionOverrides: { skills: {}, mcp: {}, revision: 1 },
      });
      const result = yield* adapter.extensions.reconcileOverrides!({
        threadId: asThreadId("thread-failure"),
        cwd: "/workspace",
        runtimeMode: "full-access",
        skillOverrides: {},
        mcpOverrides: { [ProviderExtensionItemId.make("postgres")]: "disabled" },
        extensionOverridesRevision: 2,
      }).pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      const state = yield* adapter.extensions.reconciliationState!(asThreadId("thread-failure"));
      NodeAssert.equal(state.appliedOverrideRevision, 1);
      NodeAssert.equal(state.pendingOverrideRevision, 2);
      NodeAssert.equal(state.error?.retryable, true);
      NodeAssert.match(state.error?.message ?? "", /confirmation failed/);
    }),
  );
});

it.effect("dispatches exact selected skills and rejects stale or disabled selections", () => {
  const skillPath = "/workspace/.agents/skills/review/SKILL.md";
  const runtimeFactory = makeRuntimeFactory((runtime) => {
    runtime.listSkillsImpl.mockImplementation((input) =>
      Promise.resolve({
        data: [
          {
            cwd: input.cwd,
            errors: [],
            skills: [
              {
                name: "review",
                path: skillPath,
                enabled: true,
                description: "Review changes",
                scope: "repo",
              },
            ],
          },
        ],
      }),
    );
  });

  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      const skillId = ProviderExtensionItemId.make(skillPath);
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-skills"),
        cwd: "/workspace",
        runtimeMode: "full-access",
        extensionOverrides: { skills: {}, mcp: {}, revision: 0 },
      });
      const runtime = runtimeFactory.lastRuntime!;
      yield* adapter.sendTurn({
        threadId: asThreadId("thread-skills"),
        input: "Review this",
        selectedSkills: [{ id: skillId, name: "review", path: skillPath }],
      });
      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0]?.selectedSkills, [
        { name: "review", path: skillPath },
      ]);

      yield* adapter.extensions.reconcileOverrides!({
        threadId: asThreadId("thread-skills"),
        cwd: "/workspace",
        runtimeMode: "full-access",
        skillOverrides: { [skillId]: "disabled" },
        mcpOverrides: {},
        extensionOverridesRevision: 1,
        defer: true,
      });
      const disabled = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-skills"),
          input: "Review again",
          selectedSkills: [{ id: skillId, name: "review", path: skillPath }],
        })
        .pipe(Effect.result);
      NodeAssert.equal(disabled._tag, "Failure");
      NodeAssert.ok(
        disabled._tag === "Failure" && isProviderAdapterStaleSkillSelectionError(disabled.failure),
      );
      if (
        disabled._tag === "Failure" &&
        disabled.failure._tag === "ProviderAdapterStaleSkillSelectionError"
      ) {
        NodeAssert.equal(disabled.failure.reason, "disabled");
      }

      const stale = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-skills"),
          input: "Wrong identity",
          selectedSkills: [
            {
              id: ProviderExtensionItemId.make("/other/review/SKILL.md"),
              name: "review",
              path: "/other/review/SKILL.md",
            },
          ],
        })
        .pipe(Effect.result);
      NodeAssert.equal(stale._tag, "Failure");
      if (
        stale._tag === "Failure" &&
        stale.failure._tag === "ProviderAdapterStaleSkillSelectionError"
      ) {
        NodeAssert.equal(stale.failure.reason, "missing");
      }
    }),
  );
});

it.effect("returns cwd-specific and global skills without collapsing duplicate names", () => {
  const runtimeFactory = makeRuntimeFactory((runtime) => {
    runtime.listSkillsImpl.mockImplementation((input) =>
      Promise.resolve({
        data: [
          {
            cwd: input.cwd,
            errors: [],
            skills: [
              {
                name: "shared-name",
                path: `${input.cwd}/.agents/skills/shared-name/SKILL.md`,
                enabled: true,
                description: `Skill for ${input.cwd}`,
                scope: "repo" as const,
              },
              {
                name: "shared-name",
                path: "/home/test/.codex/skills/shared-name/SKILL.md",
                enabled: true,
                description: "Global skill",
                scope: "user" as const,
              },
            ],
          },
        ],
      }),
    );
  });

  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      const repoA = yield* adapter.extensions.skills!.inventory({
        threadId: asThreadId("thread-repo-a"),
        cwd: "/workspace/repo-a",
      });
      const repoB = yield* adapter.extensions.skills!.inventory({
        threadId: asThreadId("thread-repo-b"),
        cwd: "/workspace/repo-b",
      });

      NodeAssert.deepStrictEqual(
        repoA.items.map((skill) => [skill.name, skill.path, skill.scope]),
        [
          ["shared-name", "/workspace/repo-a/.agents/skills/shared-name/SKILL.md", "project"],
          ["shared-name", "/home/test/.codex/skills/shared-name/SKILL.md", "user"],
        ],
      );
      NodeAssert.deepStrictEqual(
        repoB.items.map((skill) => skill.path),
        [
          "/workspace/repo-b/.agents/skills/shared-name/SKILL.md",
          "/home/test/.codex/skills/shared-name/SKILL.md",
        ],
      );
      NodeAssert.equal(new Set(repoA.items.map((skill) => skill.id)).size, 2);
      NodeAssert.equal(runtimeFactory.factory.mock.calls.length, 2);
      NodeAssert.deepStrictEqual(CODEX_EXTENSION_CAPABILITIES.skills, {
        inventory: true,
        refresh: true,
        threadOverride: true,
      });
    }),
  );
});

it.effect("reuses a lazily initialized management runtime for the first turn", () => {
  const runtimeFactory = makeRuntimeFactory();
  const threadId = asThreadId("thread-lazy-management");

  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.extensions.skills!.inventory({
        threadId,
        cwd: "/workspace/lazy",
      });
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      NodeAssert.equal(runtimeFactory.factory.mock.calls.length, 1);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        cwd: "/workspace/lazy",
        runtimeMode: "auto-accept-edits",
      });

      NodeAssert.equal(runtimeFactory.factory.mock.calls.length, 1);
      NodeAssert.equal(runtimeFactory.lastRuntime?.startImpl.mock.calls.length, 1);
      NodeAssert.deepStrictEqual(runtimeFactory.lastRuntime?.startImpl.mock.calls[0]?.[0], {
        cwd: "/workspace/lazy",
        runtimeMode: "auto-accept-edits",
      });
      NodeAssert.equal(yield* adapter.hasSession(threadId), true);
    }),
  );
});

it.effect("restarts a prepared runtime when managed MCP credentials appear", () => {
  const runtimeFactory = makeRuntimeFactory();
  const threadId = asThreadId("thread-lazy-managed-mcp");

  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.extensions.skills!.inventory({ threadId, cwd: "/workspace/lazy-mcp" });
      const preparedRuntime = runtimeFactory.lastRuntime;
      NodeAssert.ok(preparedRuntime);

      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-managed-mcp"),
        threadId,
        providerSessionId: "managed-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:4123/mcp",
        authorizationHeader: "Bearer managed-token",
      });

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        cwd: "/workspace/lazy-mcp",
        runtimeMode: "auto-accept-edits",
      });

      NodeAssert.equal(runtimeFactory.factory.mock.calls.length, 2);
      NodeAssert.equal(preparedRuntime.closeImpl.mock.calls.length, 1);
      NodeAssert.deepStrictEqual(runtimeFactory.lastRuntime?.options.appServerArgs, [
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1:4123/mcp",
        "-c",
        'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
      ]);
      NodeAssert.equal(
        runtimeFactory.lastRuntime?.options.environment?.T3_MCP_BEARER_TOKEN,
        "managed-token",
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    ),
  );
});

it.effect("caches skills by cwd, bypasses caches on force reload, and refreshes on change", () => {
  const runtimeFactory = makeRuntimeFactory();
  const threadId = asThreadId("thread-skill-cache");

  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      const input = { threadId, cwd: "/workspace/cache" } as const;
      yield* adapter.extensions.skills!.inventory(input);
      yield* adapter.extensions.skills!.inventory(input);
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.listSkillsImpl.mock.calls.length, 1);

      yield* adapter.extensions.skills!.inventory({ ...input, forceReload: true });
      NodeAssert.equal(runtime.listSkillsImpl.mock.calls.length, 2);
      NodeAssert.equal(runtime.listSkillsImpl.mock.calls[1]?.[0].forceReload, true);

      const eventsFiber = yield* adapter.extensions.events.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* runtime.emit({
        id: asEventId("evt-skills-changed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "skills/changed",
        payload: {},
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));

      NodeAssert.deepStrictEqual(
        events.map((event) => event.type),
        ["inventory.invalidated", "inventory.updated"],
      );
      NodeAssert.equal(runtime.listSkillsImpl.mock.calls.length, 3);
      NodeAssert.equal(runtime.listSkillsImpl.mock.calls[2]?.[0].cwd, "/workspace/cache");
      NodeAssert.equal(runtime.listSkillsImpl.mock.calls[2]?.[0].forceReload, true);
    }),
  );
});

it.effect("deduplicates concurrent skill refreshes and discards late results", () => {
  type SkillResponse = EffectCodexSchema.V2SkillsListResponse;
  let resolveSlow: ((response: SkillResponse) => void) | undefined;
  let markSlowStarted: (() => void) | undefined;
  const slowResponse = new Promise<SkillResponse>((resolve) => {
    resolveSlow = resolve;
  });
  const slowStarted = new Promise<void>((resolve) => {
    markSlowStarted = resolve;
  });
  const runtimeFactory = makeRuntimeFactory((runtime) => {
    runtime.listSkillsImpl.mockImplementationOnce(() => {
      markSlowStarted?.();
      return slowResponse;
    });
    runtime.listSkillsImpl.mockImplementationOnce((input) =>
      Promise.resolve({
        data: [
          {
            cwd: input.cwd,
            errors: [],
            skills: [
              {
                name: "new-skill",
                path: `${input.cwd}/new/SKILL.md`,
                enabled: true,
                description: "New result",
                scope: "repo" as const,
              },
            ],
          },
        ],
      }),
    );
  });
  const threadId = asThreadId("thread-concurrent-cache");

  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      const input = { threadId, cwd: "/workspace/concurrent" } as const;
      const first = yield* adapter.extensions.skills!.inventory(input).pipe(Effect.forkChild);
      yield* Effect.promise(() => slowStarted);
      const duplicate = yield* adapter.extensions.skills!.inventory(input).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeFactory.lastRuntime?.listSkillsImpl.mock.calls.length, 1);

      const forced = yield* adapter.extensions.skills!.inventory({
        ...input,
        forceReload: true,
      });
      NodeAssert.equal(forced.items[0]?.name, "new-skill");
      NodeAssert.ok(resolveSlow);
      resolveSlow({
        data: [
          {
            cwd: input.cwd,
            errors: [],
            skills: [
              {
                name: "old-skill",
                path: `${input.cwd}/old/SKILL.md`,
                enabled: true,
                description: "Late old result",
                scope: "repo",
              },
            ],
          },
        ],
      });

      const [firstResult, duplicateResult] = yield* Effect.all(
        [Fiber.join(first), Fiber.join(duplicate)],
        { concurrency: "unbounded" },
      );
      NodeAssert.equal(firstResult.items[0]?.name, "new-skill");
      NodeAssert.equal(duplicateResult.items[0]?.name, "new-skill");
      NodeAssert.equal(firstResult.revision, forced.revision);
      NodeAssert.equal(runtimeFactory.lastRuntime?.listSkillsImpl.mock.calls.length, 2);
    }),
  );
});

it("merges layered MCP definitions and locks the injected T3 server", () => {
  const userLayer = {
    name: { type: "user" as const, file: "/home/test/.codex/config.toml" },
    version: "1",
    config: {
      mcp_servers: {
        shared: { enabled: true, command: "user-server" },
      },
    },
  };
  const projectLayer = {
    name: { type: "project" as const, dotCodexFolder: "/workspace/repo/.codex" },
    version: "2",
    config: {
      mcp_servers: {
        shared: { enabled: false, command: "project-server" },
      },
    },
  };
  const definitions = parseCodexMcpDefinitions(
    {
      config: {
        mcp_servers: {
          shared: { enabled: false, command: "project-server" },
        },
      },
      layers: [userLayer, projectLayer],
      origins: {
        "mcp_servers.shared": {
          name: projectLayer.name,
          version: projectLayer.version,
        },
      },
    },
    new Set(["t3-code"]),
  );

  NodeAssert.deepStrictEqual(
    definitions.map((definition) => ({
      name: definition.name,
      providerEnabled: definition.providerEnabled,
      managed: definition.managed,
      toggleable: definition.toggleable,
      origins: definition.origins.map((origin) => [origin.scope, origin.effective]),
    })),
    [
      {
        name: "shared",
        providerEnabled: false,
        managed: false,
        toggleable: true,
        origins: [
          ["user", false],
          ["project", true],
        ],
      },
      {
        name: "t3-code",
        providerEnabled: true,
        managed: true,
        toggleable: false,
        origins: [["unknown", true]],
      },
    ],
  );
});

it.effect("overlays MCP live status notifications without polling", () => {
  const runtimeFactory = makeRuntimeFactory((runtime) => {
    runtime.readMcpConfigImpl.mockImplementation(() =>
      Promise.resolve({
        config: { mcp_servers: { docs: { enabled: true } } },
        origins: {},
        layers: [],
      }),
    );
    runtime.listMcpServerStatusImpl.mockImplementation(() =>
      Promise.resolve({
        data: [
          {
            name: "docs",
            authStatus: "notLoggedIn" as const,
            serverInfo: null,
            tools: {},
            resources: [],
            resourceTemplates: [],
          },
        ],
        nextCursor: null,
      }),
    );
  });
  const threadId = asThreadId("thread-mcp-status");

  return withExtensionsTestAdapter(runtimeFactory, (adapter) =>
    Effect.gen(function* () {
      const input = { threadId, cwd: "/workspace/mcp" } as const;
      const initial = yield* adapter.extensions.mcp!.inventory(input);
      NodeAssert.deepStrictEqual(initial.items[0], {
        id: "docs",
        name: "docs",
        origins: [],
        providerEnabled: true,
        managed: false,
        toggleable: true,
        startupStatus: "unknown",
        authStatus: "needs-auth",
        statusObserved: true,
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      yield* runtime.emit({
        id: asEventId("evt-mcp-ready"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "mcpServer/startupStatus/updated",
        payload: {
          name: "docs",
          status: "ready",
          error: null,
          failureReason: null,
        },
      });
      yield* Effect.yieldNow;
      const updated = yield* adapter.extensions.mcp!.inventory(input);

      NodeAssert.equal(updated.items[0]?.startupStatus, "ready");
      yield* runtime.emit({
        id: asEventId("evt-mcp-authenticated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "mcpServer/oauthLogin/completed",
        payload: {
          name: "docs",
          success: true,
          error: null,
        },
      });
      yield* Effect.yieldNow;
      const authenticated = yield* adapter.extensions.mcp!.inventory(input);
      NodeAssert.equal(authenticated.items[0]?.authStatus, "authenticated");
      NodeAssert.ok(authenticated.revision > initial.revision);
      NodeAssert.equal(runtime.listMcpServerStatusImpl.mock.calls.length, 1);

      yield* runtime.emit({
        id: asEventId("evt-mcp-auth-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "mcpServer/oauthLogin/completed",
        payload: {
          name: "docs",
          success: false,
          error: null,
        },
      });
      yield* Effect.yieldNow;
      const authFailed = yield* adapter.extensions.mcp!.inventory(input);
      NodeAssert.equal(authFailed.items[0]?.authStatus, "needs-auth");
      NodeAssert.equal(authFailed.items[0]?.error, "Authentication did not complete.");
      NodeAssert.deepStrictEqual(CODEX_EXTENSION_CAPABILITIES.mcp, {
        inventory: true,
        liveStatus: true,
        threadOverride: true,
        reconnect: false,
        authenticate: true,
      });
    }),
  );
});

it.effect("flushes managed native logs when the adapter layer shuts down", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-codex-adapter-native-log-"),
    );
    const basePath = NodePath.join(tempDir, "provider-native.ndjson");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-native-log"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        message: "native flush test",
      } satisfies ProviderEvent);
      yield* Fiber.join(firstEventFiber);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;

      const threadLogPath = NodePath.join(tempDir, "provider-native.thread-logger.log");
      NodeAssert.equal(NodeFS.existsSync(threadLogPath), true);
      const contents = NodeFS.readFileSync(threadLogPath, "utf8");
      NodeAssert.match(contents, /NTIVE: .*"message":"native flush test"/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);
