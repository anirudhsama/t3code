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
      statusObserved: true,
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

const roundTrip = <A, I, E1, R1, E2, R2>(
  decode: (value: unknown) => Effect.Effect<A, E1, R1>,
  encode: (value: A) => Effect.Effect<I, E2, R2>,
  value: unknown,
) =>
  Effect.gen(function* () {
    const decoded = yield* decode(value);
    const encoded = yield* encode(decoded);
    assert.deepStrictEqual(encoded, value);
  });

const snapshotRoundTrip = roundTrip(
  Schema.decodeUnknownEffect(ThreadExtensionsSnapshot),
  Schema.encodeEffect(ThreadExtensionsSnapshot),
  snapshot,
);

const rpcRoundTrips = [
  roundTrip(
    Schema.decodeUnknownEffect(ThreadExtensionsRpcSchemas.getThreadSnapshot.input),
    Schema.encodeEffect(ThreadExtensionsRpcSchemas.getThreadSnapshot.input),
    { threadId: "thread-1" },
  ),
  roundTrip(
    Schema.decodeUnknownEffect(ThreadExtensionsRpcSchemas.getPreviewSnapshot.input),
    Schema.encodeEffect(ThreadExtensionsRpcSchemas.getPreviewSnapshot.input),
    {
      threadId: "thread-pending",
      projectId: "project-1",
      providerInstanceId: "codex",
    },
  ),
  roundTrip(
    Schema.decodeUnknownEffect(ThreadExtensionsRpcSchemas.refreshThread.input),
    Schema.encodeEffect(ThreadExtensionsRpcSchemas.refreshThread.input),
    { threadId: "thread-1", domain: "skills" },
  ),
  roundTrip(
    Schema.decodeUnknownEffect(ThreadExtensionsRpcSchemas.refreshPreview.input),
    Schema.encodeEffect(ThreadExtensionsRpcSchemas.refreshPreview.input),
    {
      threadId: "thread-pending",
      projectId: "project-1",
      providerInstanceId: "codex",
      domain: "mcp",
    },
  ),
  roundTrip(
    Schema.decodeUnknownEffect(ThreadExtensionsRpcSchemas.subscribeThread.input),
    Schema.encodeEffect(ThreadExtensionsRpcSchemas.subscribeThread.input),
    { threadId: "thread-1" },
  ),
  roundTrip(
    Schema.decodeUnknownEffect(ThreadExtensionsRpcSchemas.subscribePreview.input),
    Schema.encodeEffect(ThreadExtensionsRpcSchemas.subscribePreview.input),
    {
      threadId: "thread-pending",
      projectId: "project-1",
      providerInstanceId: "codex",
    },
  ),
  roundTrip(
    Schema.decodeUnknownEffect(ThreadExtensionsRpcSchemas.reconnectMcp.input),
    Schema.encodeEffect(ThreadExtensionsRpcSchemas.reconnectMcp.input),
    { threadId: "thread-1", mcpServerId: "github" },
  ),
  roundTrip(
    Schema.decodeUnknownEffect(ThreadExtensionsRpcSchemas.beginMcpAuth.input),
    Schema.encodeEffect(ThreadExtensionsRpcSchemas.beginMcpAuth.input),
    { threadId: "thread-1", mcpServerId: "github" },
  ),
  roundTrip(
    Schema.decodeUnknownEffect(ThreadExtensionsRpcSchemas.beginMcpAuth.input),
    Schema.encodeEffect(ThreadExtensionsRpcSchemas.beginMcpAuth.input),
    {
      threadId: "thread-pending",
      projectId: "project-1",
      providerInstanceId: "codex",
      mcpServerId: "github",
    },
  ),
];

const streamRoundTrip = roundTrip(
  Schema.decodeUnknownEffect(ThreadExtensionsStreamItem),
  Schema.encodeEffect(ThreadExtensionsStreamItem),
  { kind: "snapshot", snapshot } as const,
);

const authRoundTrip = roundTrip(
  Schema.decodeUnknownEffect(ThreadExtensionsMcpAuthResult),
  Schema.encodeEffect(ThreadExtensionsMcpAuthResult),
  { snapshot, authorizationUrl: "https://example.com/login" } as const,
);

it.effect("round-trips a thread extensions snapshot", () => snapshotRoundTrip);

it.effect("round-trips extension RPC payloads and results", () =>
  Effect.gen(function* () {
    for (const effect of rpcRoundTrips) {
      yield* effect;
    }
    yield* streamRoundTrip;
    yield* authRoundTrip;
  }),
);
