import {
  ProjectId,
  ProviderDriverKind,
  ProviderExtensionItemId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderMcpAuthError } from "../Errors.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import { makeThreadExtensions } from "./ThreadExtensions.ts";

const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const INSTANCE_ID = ProviderInstanceId.make("codex-work");
const NOW = "2026-01-01T00:00:00.000Z";

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: process.cwd(),
  defaultModelSelection: { instanceId: INSTANCE_ID, model: "gpt-5-codex" },
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const thread = (input?: {
  readonly id?: ThreadId;
  readonly skillState?: "enabled" | "disabled";
  readonly mcpState?: "enabled" | "disabled";
  readonly revision?: number;
  readonly worktreePath?: string | null;
}): OrchestrationThread => ({
  id: input?.id ?? THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: input?.worktreePath ?? null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  skillOverrides: input?.skillState
    ? { [ProviderExtensionItemId.make("/repo/review/SKILL.md")]: input.skillState }
    : {},
  mcpOverrides: input?.mcpState ? { [ProviderExtensionItemId.make("github")]: input.mcpState } : {},
  extensionOverridesRevision: input?.revision ?? 0,
});

function makeInstance(reconciliation: "failed" | "idle" = "failed"): ProviderInstance {
  return {
    instanceId: INSTANCE_ID,
    driverKind: ProviderDriverKind.make("codex"),
    enabled: true,
    extensions: {
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
      skills: {
        inventory: () =>
          Effect.succeed({
            items: [
              {
                id: ProviderExtensionItemId.make("/repo/review/SKILL.md"),
                name: "review",
                scope: "project" as const,
                providerEnabled: true,
              },
            ],
            revision: 4,
            warnings: [],
          }),
        refresh: () =>
          Effect.succeed({
            items: [],
            revision: 5,
            warnings: [],
          }),
      },
      mcp: {
        inventory: () =>
          Effect.succeed({
            items: [
              {
                id: ProviderExtensionItemId.make("github"),
                name: "github",
                origins: [],
                providerEnabled: true,
                managed: false,
                toggleable: true,
                startupStatus: "ready" as const,
                authStatus: "authenticated" as const,
                statusObserved: true,
                toolCount: 20,
                resourceCount: 2,
                resourceTemplateCount: 1,
              },
              {
                id: ProviderExtensionItemId.make("t3-code"),
                name: "t3-code",
                origins: [],
                providerEnabled: true,
                managed: true,
                toggleable: false,
                startupStatus: "ready" as const,
                authStatus: "authenticated" as const,
                statusObserved: true,
                toolCount: 3,
                resourceCount: 0,
                resourceTemplateCount: 0,
              },
            ],
            revision: 7,
            warnings: [],
          }),
        refresh: () => Effect.succeed({ items: [], revision: 8, warnings: [] }),
      },
      reconciliationState: () =>
        Effect.succeed(
          reconciliation === "failed"
            ? {
                appliedOverrideRevision: 1,
                pendingOverrideRevision: 2,
                error: { domain: "all" as const, message: "retry me", retryable: true as const },
              }
            : {
                appliedOverrideRevision: 0,
                pendingOverrideRevision: undefined,
                error: undefined,
              },
        ),
      events: Stream.empty,
    },
  } as unknown as ProviderInstance;
}

function makeService(input: {
  readonly threads: ReadonlyMap<ThreadId, OrchestrationThread>;
  readonly active: boolean;
  readonly instance?: ProviderInstance;
}) {
  const instance = input.instance ?? makeInstance();
  const projection = ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
    getThreadDetailById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(input.threads.get(threadId))),
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);
  const orchestration = OrchestrationEngine.OrchestrationEngineService.of({
    streamDomainEvents: Stream.empty,
  } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]);
  const registry = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
    getInstance: (instanceId: ProviderInstanceId) =>
      Effect.succeed(instanceId === INSTANCE_ID ? instance : undefined),
    streamChanges: Stream.empty,
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
  const providers = ProviderService.ProviderService.of({
    listSessions: () =>
      Effect.succeed(
        input.active
          ? [
              {
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: INSTANCE_ID,
                status: "ready" as const,
                runtimeMode: "full-access" as const,
                threadId: THREAD_ID,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ]
          : [],
      ),
  } as unknown as ProviderService.ProviderService["Service"]);
  return makeThreadExtensions().pipe(
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projection),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, orchestration),
    Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, registry),
    Effect.provideService(ProviderService.ProviderService, providers),
    Effect.provide(
      FileSystem.layerNoop({
        realPath: (path) => Effect.succeed(path),
      }),
    ),
  );
}

describe("ThreadExtensions", () => {
  it.effect("joins raw inventory with thread-local overrides and reconciliation", () =>
    Effect.gen(function* () {
      const current = thread({ skillState: "disabled", mcpState: "disabled", revision: 2 });
      const service = yield* makeService({
        threads: new Map([[THREAD_ID, current]]),
        active: true,
      });
      const snapshot = yield* service.snapshot({ threadId: THREAD_ID });

      expect(snapshot.cwd).toBe(process.cwd());
      expect(snapshot.overrideRevision).toBe(2);
      expect(snapshot.appliedOverrideRevision).toBe(1);
      expect(snapshot.skills[0]).toMatchObject({
        threadOverride: "disabled",
        effectiveEnabled: false,
      });
      expect(snapshot.mcpServers[0]).toMatchObject({
        threadOverride: "disabled",
        effectiveEnabled: false,
        toolCount: 20,
      });
      expect(snapshot.mcpServers[1]).toMatchObject({
        id: "t3-code",
        threadOverride: "inherit",
        effectiveEnabled: true,
        toggleable: false,
      });
      expect(snapshot.errors).toContainEqual({
        domain: "all",
        message: "retry me",
        retryable: true,
      });
    }),
  );

  it.effect("treats desired overrides as applied when no provider session exists", () =>
    Effect.gen(function* () {
      const current = thread({ skillState: "disabled", revision: 9 });
      const service = yield* makeService({
        threads: new Map([[THREAD_ID, current]]),
        active: false,
        instance: makeInstance("idle"),
      });
      const snapshot = yield* service.snapshot({ threadId: THREAD_ID });
      expect(snapshot.appliedOverrideRevision).toBe(9);
      expect(snapshot.errors).toEqual([]);
    }),
  );

  it.effect("keeps failed reconciliation visible after its provider session exits", () =>
    Effect.gen(function* () {
      const current = thread({ skillState: "disabled", revision: 2 });
      const service = yield* makeService({
        threads: new Map([[THREAD_ID, current]]),
        active: false,
      });
      const snapshot = yield* service.snapshot({ threadId: THREAD_ID });
      expect(snapshot.appliedOverrideRevision).toBe(1);
      expect(snapshot.errors).toContainEqual({
        domain: "all",
        message: "retry me",
        retryable: true,
      });
    }),
  );

  it.effect("resolves draft preview cwd from project identity and rejects existing threads", () =>
    Effect.gen(function* () {
      const pendingId = ThreadId.make("pending-thread");
      let previewModel: string | undefined;
      const base = makeInstance("idle");
      const service = yield* makeService({
        threads: new Map([[THREAD_ID, thread()]]),
        active: false,
        instance: {
          ...base,
          extensions: {
            ...base.extensions!,
            skills: {
              ...base.extensions!.skills!,
              inventory: (input) => {
                previewModel = input.modelSelection?.model;
                return base.extensions!.skills!.inventory(input);
              },
            },
          },
        },
      });
      const preview = yield* service.previewSnapshot({
        threadId: pendingId,
        projectId: PROJECT_ID,
        providerInstanceId: INSTANCE_ID,
      });
      expect(preview.threadId).toBe(pendingId);
      expect(preview.cwd).toBe(process.cwd());
      expect(preview.overrideRevision).toBe(0);
      expect(previewModel).toBe("gpt-5-codex");

      const error = yield* service
        .previewSnapshot({
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          providerInstanceId: INSTANCE_ID,
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid-state");
    }),
  );

  it.effect("begins and relays MCP authentication through a prepared draft runtime", () =>
    Effect.gen(function* () {
      const pendingId = ThreadId.make("pending-auth-thread");
      let authenticatedThreadId: ThreadId | null = null;
      let relayedCallback: string | null = null;
      const base = makeInstance();
      const instance = {
        ...base,
        extensions: {
          ...base.extensions!,
          mcp: {
            ...base.extensions!.mcp!,
            authenticate: (input) => {
              authenticatedThreadId = input.threadId;
              return Effect.succeed({ authorizationUrl: "https://example.test/authorize" });
            },
            relayAuthenticationCallback: (input) => {
              relayedCallback = input.callbackUrl;
              return Effect.void;
            },
          },
        },
      } as ProviderInstance;
      const service = yield* makeService({ threads: new Map(), active: false, instance });
      const result = yield* service.beginMcpAuth!({
        threadId: pendingId,
        projectId: PROJECT_ID,
        providerInstanceId: INSTANCE_ID,
        mcpServerId: ProviderExtensionItemId.make("github"),
      });

      expect(authenticatedThreadId).toBe(pendingId);
      expect(result.authorizationUrl).toBe("https://example.test/authorize");
      expect(result.snapshot.threadId).toBe(pendingId);

      const relayed = yield* service.relayMcpAuthCallback!({
        threadId: pendingId,
        projectId: PROJECT_ID,
        providerInstanceId: INSTANCE_ID,
        mcpServerId: ProviderExtensionItemId.make("github"),
        callbackUrl: "http://127.0.0.1:43123/callback/state?code=opaque",
      });
      expect(relayedCallback).toBe("http://127.0.0.1:43123/callback/state?code=opaque");
      expect(relayed.threadId).toBe(pendingId);
    }),
  );

  it.effect("maps callback mismatches to a typed error without exposing the URL", () =>
    Effect.gen(function* () {
      const secret = "oauth-code-secret";
      const base = makeInstance();
      const instance = {
        ...base,
        extensions: {
          ...base.extensions!,
          mcp: {
            ...base.extensions!.mcp!,
            relayAuthenticationCallback: () =>
              Effect.fail(
                new ProviderMcpAuthError({
                  reason: "invalid-callback",
                  detail: "The redirect URL does not match the pending authentication callback.",
                  retryable: true,
                }),
              ),
          },
        },
      } as ProviderInstance;
      const service = yield* makeService({
        threads: new Map([[THREAD_ID, thread()]]),
        active: false,
        instance,
      });
      const error = yield* service.relayMcpAuthCallback!({
        threadId: THREAD_ID,
        mcpServerId: ProviderExtensionItemId.make("github"),
        callbackUrl: `http://127.0.0.1:43123/callback/state?code=${secret}`,
      }).pipe(Effect.flip);

      expect(error.reason).toBe("invalid-callback");
      expect(error.retryable).toBe(true);
      expect(error.message).not.toContain(secret);
      expect(error.cause).toBeUndefined();
    }),
  );

  it.effect("returns the newest snapshot when an older refresh completes late", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      let refreshCount = 0;
      const base = makeInstance();
      const instance = {
        ...base,
        extensions: {
          ...base.extensions!,
          skills: {
            ...base.extensions!.skills!,
            refresh: () =>
              Effect.gen(function* () {
                refreshCount += 1;
                const current = refreshCount;
                if (current === 1) {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(releaseFirst);
                }
                return {
                  items: [],
                  revision: current,
                  warnings: [],
                };
              }),
          },
        },
      } as ProviderInstance;
      const service = yield* makeService({
        threads: new Map([[THREAD_ID, thread()]]),
        active: false,
        instance,
      });
      const first = yield* service
        .refresh({ threadId: THREAD_ID, domain: "skills" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const newest = yield* service.refresh({ threadId: THREAD_ID, domain: "skills" });
      yield* Deferred.succeed(releaseFirst, undefined);
      const late = yield* Fiber.join(first);

      expect(late).toEqual(newest);
      expect(refreshCount).toBe(2);
    }),
  );
});
