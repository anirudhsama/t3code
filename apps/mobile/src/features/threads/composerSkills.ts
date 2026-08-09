import type { ProviderSelectedSkill, ProviderSkill } from "@t3tools/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

function skillDisplayName(skill: Pick<ProviderSkill, "displayName" | "name">): string {
  return skill.displayName?.trim() || skill.name;
}

export function contextualSkillSourceLabel(skill: ProviderSkill): string {
  const scope = skill.scope === "user" ? "global" : skill.scope;
  return skill.path ? `${scope} · ${skill.path}` : scope;
}

export function contextualSkillLabel(
  skill: ProviderSkill,
  skills: ReadonlyArray<ProviderSkill>,
): string {
  const duplicateName = skills.some(
    (candidate) => candidate.id !== skill.id && candidate.name === skill.name,
  );
  return duplicateName
    ? `${skillDisplayName(skill)} — ${contextualSkillSourceLabel(skill)}`
    : skillDisplayName(skill);
}

export function searchContextualSkills(
  skills: ReadonlyArray<ProviderSkill>,
  query: string,
  limit = 20,
): ProviderSkill[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\$+/ });
  if (!normalizedQuery) return skills.slice(0, limit);

  const ranked: Array<{ item: ProviderSkill; score: number; tieBreaker: string }> = [];
  for (const skill of skills) {
    const displayLabel = skillDisplayName(skill).toLowerCase();
    const sourceLabel = contextualSkillSourceLabel(skill).toLowerCase();
    const scores = [
      scoreQueryMatch({
        value: skill.name.toLowerCase(),
        query: normalizedQuery,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 4,
        includesBase: 6,
        fuzzyBase: 100,
        boundaryMarkers: ["-", "_", "/"],
      }),
      scoreQueryMatch({
        value: displayLabel,
        query: normalizedQuery,
        exactBase: 1,
        prefixBase: 3,
        boundaryBase: 5,
        includesBase: 7,
        fuzzyBase: 110,
      }),
      scoreQueryMatch({
        value: sourceLabel,
        query: normalizedQuery,
        exactBase: 10,
        prefixBase: 12,
        boundaryBase: 14,
        includesBase: 16,
      }),
      scoreQueryMatch({
        value: skill.description?.toLowerCase() ?? "",
        query: normalizedQuery,
        exactBase: 20,
        prefixBase: 22,
        boundaryBase: 24,
        includesBase: 26,
      }),
    ].filter((score): score is number => score !== null);

    if (scores.length > 0) {
      insertRankedSearchResult(
        ranked,
        {
          item: skill,
          score: Math.min(...scores),
          tieBreaker: `${displayLabel}\u0000${skill.name}\u0000${skill.id}`,
        },
        limit,
      );
    }
  }
  return ranked.map(({ item }) => item);
}

export function selectedSkillRef(skill: ProviderSkill): ProviderSelectedSkill {
  return {
    id: skill.id,
    name: skill.name,
    ...(skill.path ? { path: skill.path } : {}),
  };
}

export function retainSelectedSkillsInText(
  text: string,
  selectedSkills: ReadonlyArray<ProviderSelectedSkill>,
): ProviderSelectedSkill[] {
  const names = new Set<string>();
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2];
    if (name) names.add(name);
  }
  return selectedSkills.filter((skill) => names.has(skill.name));
}

export function resolveSelectedSkills(
  text: string,
  skills: ReadonlyArray<ProviderSkill>,
  preferredSkills: ReadonlyArray<ProviderSelectedSkill> = [],
): ProviderSelectedSkill[] {
  const skillsByName = new Map<string, ProviderSkill[]>();
  for (const skill of skills) {
    const namedSkills = skillsByName.get(skill.name) ?? [];
    namedSkills.push(skill);
    skillsByName.set(skill.name, namedSkills);
  }
  const preferredByName = new Map(preferredSkills.map((skill) => [skill.name, skill]));
  const selectedById = new Map<ProviderSelectedSkill["id"], ProviderSelectedSkill>();

  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2];
    if (!name) continue;
    const candidates = skillsByName.get(name) ?? [];
    const preferred = preferredByName.get(name);
    const selected = preferred
      ? candidates.find((candidate) => candidate.id === preferred.id)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (selected) selectedById.set(selected.id, selectedSkillRef(selected));
  }

  return [...selectedById.values()];
}
