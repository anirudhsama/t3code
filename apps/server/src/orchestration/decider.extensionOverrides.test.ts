import {
  CommandId,
  ProjectId,
  ProviderExtensionItemId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeReadModel(
  input: {
    readonly revision?: number;
    readonly deletedAt?: string | null;
    readonly sessionStatus?: "stopped" | "running";
    readonly skillOverride?: "enabled" | "disabled";
  } = {},
): OrchestrationReadModel {
  const skillId = ProviderExtensionItemId.make("/skill/SKILL.md");
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        titleRegeneration: null,
        skillOverrides: input.skillOverride === undefined ? {} : { [skillId]: input.skillOverride },
        mcpOverrides: {},
        extensionOverridesRevision: input.revision ?? 0,
        deletedAt: input.deletedAt ?? null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session:
          input.sessionStatus === undefined
            ? null
            : {
                threadId: THREAD_ID,
                status: input.sessionStatus,
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: NOW,
              },
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread extension override decider", (it) => {
  it.effect("emits revisioned skill intent while the provider session is stopped", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.skill-override.set",
          commandId: CommandId.make("cmd-skill"),
          threadId: THREAD_ID,
          skillId: ProviderExtensionItemId.make("/repo/.codex/skills/review/SKILL.md"),
          state: "disabled",
          expectedRevision: 2,
          createdAt: NOW,
        },
        readModel: makeReadModel({ revision: 2, sessionStatus: "stopped" }),
      });

      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "thread.skill-override-set") {
        expect(events[0].payload.state).toBe("disabled");
        expect(events[0].payload.extensionOverridesRevision).toBe(3);
      }
    }),
  );

  it.effect("re-emits an identical mutation with the next revision", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.skill-override.set",
          commandId: CommandId.make("cmd-skill-identical"),
          threadId: THREAD_ID,
          skillId: ProviderExtensionItemId.make("/skill/SKILL.md"),
          state: "enabled",
          expectedRevision: 4,
          createdAt: NOW,
        },
        readModel: makeReadModel({ revision: 4, skillOverride: "enabled" }),
      });

      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.skill-override-set") {
        expect(events[0].payload.extensionOverridesRevision).toBe(5);
      }
    }),
  );

  it.effect("emits revisioned MCP intent without consulting session state", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mcp-override.set",
          commandId: CommandId.make("cmd-mcp"),
          threadId: THREAD_ID,
          mcpServerId: ProviderExtensionItemId.make("postgres"),
          state: "enabled",
          expectedRevision: 0,
          createdAt: NOW,
        },
        readModel: makeReadModel({ sessionStatus: "running" }),
      });

      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.mcp-override-set") {
        expect(events[0].payload.extensionOverridesRevision).toBe(1);
      }
    }),
  );

  it.effect("rejects a stale expected revision", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mcp-override.set",
          commandId: CommandId.make("cmd-stale"),
          threadId: THREAD_ID,
          mcpServerId: ProviderExtensionItemId.make("postgres"),
          state: "disabled",
          expectedRevision: 1,
          createdAt: NOW,
        },
        readModel: makeReadModel({ revision: 2 }),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("revision is 2; expected 1");
      }
    }),
  );

  it.effect("rejects missing and deleted threads", () =>
    Effect.gen(function* () {
      const command = {
        type: "thread.skill-override.set" as const,
        commandId: CommandId.make("cmd-invalid-thread"),
        threadId: THREAD_ID,
        skillId: ProviderExtensionItemId.make("/skill/SKILL.md"),
        state: "inherit" as const,
        expectedRevision: 0,
        createdAt: NOW,
      };
      const missing = yield* decideOrchestrationCommand({
        command,
        readModel: { ...makeReadModel(), threads: [] },
      }).pipe(Effect.flip);
      const deleted = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel({ deletedAt: NOW }),
      }).pipe(Effect.flip);

      if (missing._tag === "OrchestrationCommandInvariantError") {
        expect(missing.detail).toContain("does not exist");
      }
      if (deleted._tag === "OrchestrationCommandInvariantError") {
        expect(deleted.detail).toContain("is deleted");
      }
    }),
  );
});
