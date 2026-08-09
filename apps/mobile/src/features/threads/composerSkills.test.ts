import { describe, expect, it } from "@effect/vitest";
import { ProviderExtensionItemId, type ProviderSkill } from "@t3tools/contracts";

import {
  contextualSkillLabel,
  resolveSelectedSkills,
  retainSelectedSkillsInText,
  searchContextualSkills,
  selectedSkillRef,
} from "./composerSkills";

function skill(input: {
  readonly id: string;
  readonly name: string;
  readonly scope: ProviderSkill["scope"];
  readonly path?: string;
  readonly displayName?: string;
}): ProviderSkill {
  return {
    id: ProviderExtensionItemId.make(input.id),
    name: input.name,
    scope: input.scope,
    ...(input.path ? { path: input.path } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    providerEnabled: true,
    threadOverride: "inherit",
    effectiveEnabled: true,
  };
}

describe("mobile contextual composer skills", () => {
  const projectReview = skill({
    id: "/repo/.agents/skills/review/SKILL.md",
    name: "review",
    scope: "project",
    path: "/repo/.agents/skills/review/SKILL.md",
    displayName: "Review",
  });
  const globalReview = skill({
    id: "/home/me/.agents/skills/review/SKILL.md",
    name: "review",
    scope: "user",
    path: "/home/me/.agents/skills/review/SKILL.md",
    displayName: "Review",
  });
  const testing = skill({
    id: "/repo/.agents/skills/testing/SKILL.md",
    name: "testing",
    scope: "project",
    path: "/repo/.agents/skills/testing/SKILL.md",
  });
  const skills = [projectReview, globalReview, testing];

  it("keeps duplicate names path-distinct and disambiguates their labels", () => {
    expect(searchContextualSkills(skills, "").map((item) => item.id)).toEqual(
      skills.map((item) => item.id),
    );
    expect(contextualSkillLabel(projectReview, skills)).toBe(
      "Review — project · /repo/.agents/skills/review/SKILL.md",
    );
    expect(contextualSkillLabel(globalReview, skills)).toBe(
      "Review — global · /home/me/.agents/skills/review/SKILL.md",
    );
    expect(searchContextualSkills(skills, "/repo/.agents/skills/testing")).toEqual([testing]);
  });

  it("resolves unique text tokens and the exact preferred duplicate ref", () => {
    expect(
      resolveSelectedSkills("Use $review then $testing", skills, [selectedSkillRef(globalReview)]),
    ).toEqual([selectedSkillRef(globalReview), selectedSkillRef(testing)]);
    expect(resolveSelectedSkills("Use $review", skills)).toEqual([]);
    expect(resolveSelectedSkills("Use $testing", skills)).toEqual([selectedSkillRef(testing)]);
  });

  it("drops selected refs after their text token is removed", () => {
    expect(
      retainSelectedSkillsInText("Keep $testing only", [
        selectedSkillRef(projectReview),
        selectedSkillRef(testing),
      ]),
    ).toEqual([selectedSkillRef(testing)]);
  });
});
