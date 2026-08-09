/** Read-only discovery helpers for joining Claude's SDK skill catalog to stable paths. */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

export type ClaudeSkillCandidateScope = "admin" | "user" | "project" | "plugin";

export interface ClaudeSkillCandidate {
  readonly name: string;
  readonly providerName: string;
  readonly description?: string;
  readonly path: string;
  readonly declaredPath: string;
  readonly scope: ClaudeSkillCandidateScope;
  readonly label: string;
  readonly precedence: number;
}

export interface ClaudePluginRoot {
  readonly name: string;
  readonly path: string;
  readonly source?: string;
}

export function claudeManagedSkillDirectories(): ReadonlyArray<string> {
  if (process.platform === "darwin") {
    return ["/Library/Application Support/ClaudeCode/skills"];
  }
  if (process.platform === "win32") {
    return [`${process.env.ProgramFiles ?? "C:\\Program Files"}\\ClaudeCode\\skills`];
  }
  return ["/etc/claude-code/skills"];
}

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { kind: "missing" };
  try {
    const parsed = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null) return { kind: "malformed" };
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    return {
      kind: "parsed",
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
  } catch {
    return { kind: "malformed" };
  }
}

export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) return path.resolve(expandHomePath(homePath));
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

const projectSkillRoots = Effect.fn("projectSkillRoots")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    roots.push(path.join(current, ".claude", "skills"));
    if (
      yield* fileSystem.exists(path.join(current, ".git")).pipe(Effect.orElseSucceed(() => false))
    ) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
});

const scanRoot = Effect.fn("scanClaudeSkillRoot")(function* (root: {
  readonly directory: string;
  readonly scope: ClaudeSkillCandidateScope;
  readonly label: string;
  readonly precedence: number;
  readonly qualifier?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(root.directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const candidates: ClaudeSkillCandidate[] = [];
  for (const entry of [...entries].sort()) {
    const declaredPath = path.join(root.directory, entry, "SKILL.md");
    const contents = yield* fileSystem
      .readFileString(declaredPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) continue;
    const frontmatter = parseSkillFrontmatter(contents);
    if (frontmatter.kind === "malformed") continue;
    const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
    if (!name) continue;
    const canonicalPath = yield* fileSystem
      .realPath(declaredPath)
      .pipe(Effect.orElseSucceed(() => declaredPath));
    candidates.push({
      name,
      providerName: root.qualifier ? `${root.qualifier}:${name}` : name,
      ...(frontmatter.kind === "parsed" && frontmatter.description
        ? { description: frontmatter.description }
        : {}),
      path: canonicalPath,
      declaredPath,
      scope: root.scope,
      label: root.label,
      precedence: root.precedence,
    });
  }
  return candidates;
});

export const scanClaudeSkillCandidates = Effect.fn("scanClaudeSkillCandidates")(function* (input: {
  readonly config: Pick<ClaudeSettings, "homePath">;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly additionalDirectories?: ReadonlyArray<string>;
  readonly managedDirectories?: ReadonlyArray<string>;
  readonly plugins?: ReadonlyArray<ClaudePluginRoot>;
}) {
  const path = yield* Path.Path;
  const configDir = yield* resolveClaudeConfigDirPath(
    input.config,
    input.environment ?? process.env,
    input.cwd,
  );
  const projectRoots = yield* projectSkillRoots(input.cwd);
  const roots = [
    ...(input.managedDirectories ?? []).map((directory) => ({
      directory,
      scope: "admin" as const,
      label: "Managed",
      precedence: 0,
    })),
    {
      directory: path.join(configDir, "skills"),
      scope: "user" as const,
      label: "Personal",
      precedence: 1,
    },
    ...projectRoots.map((directory, index) => ({
      directory,
      scope: "project" as const,
      label: "Project",
      precedence: 2 + index,
    })),
    ...(input.additionalDirectories ?? []).map((directory, index) => ({
      directory: path.join(path.resolve(input.cwd, directory), ".claude", "skills"),
      scope: "project" as const,
      label: "Additional directory",
      precedence: 100 + index,
    })),
    ...(input.plugins ?? []).map((plugin, index) => ({
      directory: path.join(plugin.path, "skills"),
      scope: "plugin" as const,
      label: plugin.source ? `${plugin.name} (${plugin.source})` : plugin.name,
      precedence: 1_000 + index,
      qualifier: plugin.name,
    })),
  ];
  const scanned = yield* Effect.forEach(roots, scanRoot, { concurrency: "unbounded" });
  const byCanonicalPath = new Map<string, ClaudeSkillCandidate>();
  for (const candidate of scanned.flat()) {
    if (!byCanonicalPath.has(candidate.path)) byCanonicalPath.set(candidate.path, candidate);
  }
  return [...byCanonicalPath.values()].sort(
    (left, right) =>
      left.precedence - right.precedence ||
      left.providerName.localeCompare(right.providerName) ||
      left.path.localeCompare(right.path),
  );
});

/** Legacy provider-snapshot helper. Contextual management uses the raw candidate scanner above. */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const effectiveCwd = cwd ?? process.cwd();
  const candidates = yield* scanClaudeSkillCandidates({
    config,
    cwd: effectiveCwd,
    ...(environment ? { environment } : {}),
  });
  const eligible = cwd ? candidates : candidates.filter((candidate) => candidate.scope === "user");
  const winners = new Map<string, ClaudeSkillCandidate>();
  for (const candidate of eligible) {
    const previous = winners.get(candidate.providerName);
    if (!previous || candidate.precedence < previous.precedence) {
      winners.set(candidate.providerName, candidate);
    }
  }
  return [...winners.values()]
    .map((candidate) => ({
      name: candidate.providerName,
      path: candidate.path,
      enabled: true,
      scope: candidate.scope === "admin" ? "system" : candidate.scope,
      ...(candidate.description ? { description: candidate.description } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
});
