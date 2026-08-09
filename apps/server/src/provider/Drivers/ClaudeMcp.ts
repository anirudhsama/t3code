/** Read-only reconstruction of Claude MCP definition origins. */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ProviderExtensionOrigin } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ClaudePluginRoot } from "./ClaudeSkills.ts";
import { resolveClaudeConfigDirPath } from "./ClaudeSkills.ts";

const McpEnvelope = Schema.Struct({
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  projects: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const ProjectEnvelope = Schema.Struct({
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const PluginEnvelope = Schema.Struct({
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeMcpEnvelope = Schema.decodeUnknownOption(McpEnvelope);
const decodeProjectEnvelope = Schema.decodeUnknownOption(ProjectEnvelope);
const decodePluginEnvelope = Schema.decodeUnknownOption(PluginEnvelope);
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface ClaudeMcpOriginCandidate {
  readonly name: string;
  readonly origin: ProviderExtensionOrigin;
}

const readJson = Effect.fn("readClaudeMcpJson")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return undefined;
  const decoded = decodeUnknownJson(contents);
  return decoded._tag === "Some" ? decoded.value : undefined;
});

function originsFor(
  servers: Readonly<Record<string, unknown>> | undefined,
  input: Omit<ProviderExtensionOrigin, "effective">,
): ReadonlyArray<ClaudeMcpOriginCandidate> {
  return Object.keys(servers ?? {}).map((name) => ({
    name,
    origin: { ...input, effective: false },
  }));
}

const findProjectRoot = Effect.fn("findClaudeProjectRoot")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    if (
      yield* fileSystem.exists(path.join(current, ".git")).pipe(Effect.orElseSucceed(() => false))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
});

function managedMcpPath(path: Path.Path): string {
  if (process.platform === "darwin") {
    return path.join("/Library/Application Support/ClaudeCode", "managed-mcp.json");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "ClaudeCode",
      "managed-mcp.json",
    );
  }
  return "/etc/claude-code/managed-mcp.json";
}

export const readClaudeMcpOrigins = Effect.fn("readClaudeMcpOrigins")(function* (input: {
  readonly config: Pick<ClaudeSettings, "homePath">;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly plugins?: ReadonlyArray<ClaudePluginRoot>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = input.environment ?? process.env;
  const canonicalCwd = yield* fileSystem
    .realPath(input.cwd)
    .pipe(Effect.orElseSucceed(() => input.cwd));
  const configDir = yield* resolveClaudeConfigDirPath(input.config, environment, canonicalCwd);
  const isolated =
    input.config.homePath.trim().length > 0 || Boolean(environment.CLAUDE_CONFIG_DIR?.trim());
  const statePath = isolated
    ? path.join(configDir, ".claude.json")
    : path.join(NodeOS.homedir(), ".claude.json");
  const state = decodeMcpEnvelope(yield* readJson(statePath));
  const projectRoot = yield* findProjectRoot(canonicalCwd);
  const projectPath = path.join(projectRoot, ".mcp.json");
  const project = decodeMcpEnvelope(yield* readJson(projectPath));
  const origins: ClaudeMcpOriginCandidate[] = [];
  origins.push(
    ...originsFor(state._tag === "Some" ? state.value.mcpServers : undefined, {
      scope: "user",
      label: "User",
      path: statePath,
    }),
  );
  if (state._tag === "Some") {
    const local = decodeProjectEnvelope(state.value.projects?.[canonicalCwd]);
    origins.push(
      ...originsFor(local._tag === "Some" ? local.value.mcpServers : undefined, {
        scope: "project",
        label: "Local",
        path: statePath,
      }),
    );
  }
  origins.push(
    ...originsFor(project._tag === "Some" ? project.value.mcpServers : undefined, {
      scope: "project",
      label: "Project",
      path: projectPath,
    }),
  );
  for (const plugin of input.plugins ?? []) {
    const filePath = path.join(plugin.path, ".mcp.json");
    const fileConfig = decodeMcpEnvelope(yield* readJson(filePath));
    const manifestPath = path.join(plugin.path, ".claude-plugin", "plugin.json");
    const manifestConfig = decodePluginEnvelope(yield* readJson(manifestPath));
    const label = plugin.source ? `${plugin.name} (${plugin.source})` : plugin.name;
    origins.push(
      ...originsFor(fileConfig._tag === "Some" ? fileConfig.value.mcpServers : undefined, {
        scope: "plugin",
        label,
        path: filePath,
      }),
      ...originsFor(manifestConfig._tag === "Some" ? manifestConfig.value.mcpServers : undefined, {
        scope: "plugin",
        label,
        path: manifestPath,
      }),
    );
  }
  const managedPath = managedMcpPath(path);
  const managed = decodeMcpEnvelope(yield* readJson(managedPath));
  origins.push(
    ...originsFor(managed._tag === "Some" ? managed.value.mcpServers : undefined, {
      scope: "admin",
      label: "Admin",
      path: managedPath,
    }),
  );
  return origins;
});
