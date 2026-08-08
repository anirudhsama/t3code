import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ThreadExtensionsMcpAuthResult,
  ThreadExtensionsRpcSchemas,
  ThreadExtensionsSnapshot,
  ThreadExtensionsStreamItem,
} from "./providerExtensions.ts";

const snapshot = {
  threadId: "thread-1",
  providerInstanceId: "codex_work",
  provider: "codex",
  cwd: "/workspace/repo",
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
  skills: [
    {
      id: "/workspace/repo/.agents/skills/review/SKILL.md",
      name: "review",
      displayName: "Review",
      description: "Review a change",
      scope: "project",
      path: "/workspace/repo/.agents/skills/review/SKILL.md",
      providerEnabled: true,
      threadOverride: "disabled",
      effectiveEnabled: false,
      precedence: 0,
      origin: {
        scope: "project",
        path: "/workspace/repo/.agents/skills/review/SKILL.md",
        effective: true,
      },
    },
  ],
  mcpServers: [
    {
      id: "github",
      name: "github",
      origins: [{ scope: "user", label: "config.toml", effective: true }],
      providerEnabled: true,
      threadOverride: "inherit",
      effectiveEnabled: true,
      managed: false,
      toggleable: true,
      startupStatus: "ready",
      authStatus: "authenticated",
      serverInfo: { name: "github", version: "1" },
      toolCount: 12,
      resourceCount: 0,
      resourceTemplateCount: 1,
    },
  ],
  inventoryRevision: 7,
  overrideRevision: 3,
  appliedOverrideRevision: 2,
  loading: { skills: false, mcp: false },
  errors: [],
  refreshedAt: "2026-01-01T00:00:00.000Z",
} as const;

it.effect("round-trips a thread extensions snapshot", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(ThreadExtensionsSnapshot)(snapshot);
    const encoded = yield* Schema.encodeEffect(ThreadExtensionsSnapshot)(decoded);
    assert.deepStrictEqual(encoded, snapshot);
  }),
);

it.effect("round-trips extension RPC payloads and results", () =>
  Effect.gen(function* () {
    const cases = [
      [ThreadExtensionsRpcSchemas.getThreadSnapshot.input, { threadId: "thread-1" }],
      [
        ThreadExtensionsRpcSchemas.getPreviewSnapshot.input,
        {
          threadId: "thread-pending",
          projectId: "project-1",
          providerInstanceId: "codex",
        },
      ],
      [ThreadExtensionsRpcSchemas.refreshThread.input, { threadId: "thread-1", domain: "skills" }],
      [ThreadExtensionsRpcSchemas.subscribeThread.input, { threadId: "thread-1" }],
      [
        ThreadExtensionsRpcSchemas.reconnectMcp.input,
        { threadId: "thread-1", mcpServerId: "github" },
      ],
      [
        ThreadExtensionsRpcSchemas.beginMcpAuth.input,
        { threadId: "thread-1", mcpServerId: "github" },
      ],
    ] as const;

    for (const [schema, value] of cases) {
      const decoded = yield* Schema.decodeUnknownEffect(schema)(value);
      const encoded = yield* Schema.encodeEffect(schema)(decoded);
      assert.deepStrictEqual(encoded, value);
    }

    const streamValue = { kind: "snapshot", snapshot } as const;
    const streamDecoded = yield* Schema.decodeUnknownEffect(ThreadExtensionsStreamItem)(
      streamValue,
    );
    const streamEncoded = yield* Schema.encodeEffect(ThreadExtensionsStreamItem)(streamDecoded);
    assert.deepStrictEqual(streamEncoded, streamValue);

    const authValue = { snapshot, authorizationUrl: "https://example.com/login" } as const;
    const authDecoded = yield* Schema.decodeUnknownEffect(ThreadExtensionsMcpAuthResult)(authValue);
    const authEncoded = yield* Schema.encodeEffect(ThreadExtensionsMcpAuthResult)(authDecoded);
    assert.deepStrictEqual(authEncoded, authValue);
  }),
);
