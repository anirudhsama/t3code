import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveCodexSkillRoots } from "./CodexSkillRoots.ts";

it.layer(NodeServices.layer)("resolveCodexSkillRoots", (it) => {
  describe("personal skill roots", () => {
    it.effect("registers the personal root even when it does not exist", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-codex-skills-home-",
          });

          expect(yield* resolveCodexSkillRoots({ HOME: home })).toEqual([
            path.join(home, ".agents", "skills"),
          ]);
        }),
      ),
    );

    it.effect("registers targets of symlinked SKILL.md files", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-codex-skills-home-",
          });
          const source = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-codex-skills-source-",
          });
          const personalRoot = path.join(home, ".agents", "skills");
          const linkedSkillDirectory = path.join(personalRoot, "linked-skill");
          const sourceSkillDirectory = path.join(source, "linked-skill");
          const sourceSkillFile = path.join(sourceSkillDirectory, "SKILL.md");
          yield* fileSystem.makeDirectory(linkedSkillDirectory, { recursive: true });
          yield* fileSystem.makeDirectory(sourceSkillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(sourceSkillFile, "---\nname: linked-skill\n---\n");
          yield* fileSystem.symlink(sourceSkillFile, path.join(linkedSkillDirectory, "SKILL.md"));

          expect(yield* resolveCodexSkillRoots({ HOME: home })).toEqual([
            personalRoot,
            sourceSkillDirectory,
          ]);
        }),
      ),
    );
  });
});
