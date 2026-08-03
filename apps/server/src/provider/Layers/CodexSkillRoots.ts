// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

function resolvePersonalSkillsRoot(environment: NodeJS.ProcessEnv): string {
  const homePath = environment.HOME?.trim() || environment.USERPROFILE?.trim();
  return NodePath.join(
    homePath ? NodePath.resolve(homePath) : NodeOS.homedir(),
    ".agents",
    "skills",
  );
}

/**
 * Roots T3 registers explicitly with Codex app-server. The documented personal
 * root is always included so discovery does not depend on app-server inferring
 * the host home directory.
 *
 * Codex supports symlinked skill directories but currently ignores a real
 * directory whose SKILL.md is itself a symlink. Include those resolved skill
 * directories as roots as well so common dotfile-manager layouts still work.
 */
export const resolveCodexSkillRoots = Effect.fn("resolveCodexSkillRoots")(function* (
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const personalSkillsRoot = resolvePersonalSkillsRoot(environment);
  const entries = yield* fileSystem
    .readDirectory(personalSkillsRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const roots = new Set<string>([personalSkillsRoot]);

  yield* Effect.forEach(
    [...entries].sort(),
    (entry) =>
      Effect.gen(function* () {
        const skillFile = NodePath.join(personalSkillsRoot, entry, "SKILL.md");
        const isFileSymlink = yield* fileSystem.readLink(skillFile).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!isFileSymlink) return;

        const resolvedSkillFile = yield* fileSystem
          .realPath(skillFile)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (resolvedSkillFile) {
          roots.add(NodePath.dirname(resolvedSkillFile));
        }
      }),
    { concurrency: "unbounded", discard: true },
  );

  return [...roots];
});
