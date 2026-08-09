import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { readClaudeMcpOrigins } from "./ClaudeMcp.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("readClaudeMcpOrigins", (it) => {
  it.effect("reconstructs file-backed scopes without exposing or changing configuration", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      const cwd = path.join(baseDir, "repo");
      const configDir = path.join(baseDir, "config");
      const pluginDir = path.join(baseDir, "plugin");
      yield* fileSystem.makeDirectory(path.join(cwd, ".git"), { recursive: true });
      yield* fileSystem.makeDirectory(configDir, { recursive: true });
      yield* fileSystem.makeDirectory(pluginDir, { recursive: true });

      const statePath = path.join(configDir, ".claude.json");
      const projectPath = path.join(cwd, ".mcp.json");
      const pluginPath = path.join(pluginDir, ".mcp.json");
      yield* fileSystem.writeFileString(
        statePath,
        encodeJson({
          mcpServers: {
            user: { type: "http", url: "https://user.test", headers: { token: "secret" } },
          },
          projects: {
            [cwd]: { mcpServers: { local: { command: "local", env: { SECRET: "hidden" } } } },
          },
        }),
      );
      yield* fileSystem.writeFileString(
        projectPath,
        encodeJson({ mcpServers: { project: { command: "project" } } }),
      );
      yield* fileSystem.writeFileString(
        pluginPath,
        encodeJson({ mcpServers: { plugin: { command: "plugin" } } }),
      );
      const before = yield* Effect.all([
        fileSystem.readFileString(statePath),
        fileSystem.readFileString(projectPath),
        fileSystem.readFileString(pluginPath),
      ]);

      const origins = yield* readClaudeMcpOrigins({
        config: { homePath: configDir },
        cwd,
        environment: {},
        plugins: [{ name: "example", path: pluginDir, source: "marketplace" }],
      });

      assert.deepEqual(
        origins
          .filter((origin) => ["user", "local", "project", "plugin"].includes(origin.name))
          .map(({ name, origin }) => ({ name, scope: origin.scope, label: origin.label })),
        [
          { name: "user", scope: "user", label: "User" },
          { name: "local", scope: "project", label: "Local" },
          { name: "project", scope: "project", label: "Project" },
          { name: "plugin", scope: "plugin", label: "example (marketplace)" },
        ],
      );
      assert.equal(
        origins.every(({ origin }) => origin.metadata === undefined),
        true,
      );
      assert.deepEqual(
        yield* Effect.all([
          fileSystem.readFileString(statePath),
          fileSystem.readFileString(projectPath),
          fileSystem.readFileString(pluginPath),
        ]),
        before,
      );
    }),
  );
});
