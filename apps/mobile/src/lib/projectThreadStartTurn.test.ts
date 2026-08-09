import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, ProviderExtensionItemId, ProviderInstanceId } from "@t3tools/contracts";

vi.mock("./uuid", () => ({ uuidv4: () => "unused" }));

import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";

describe("buildProjectThreadStartTurnInput", () => {
  it("attaches structured selected skill refs to the bootstrap turn", () => {
    const selectedSkill = {
      id: ProviderExtensionItemId.make("/repo/.agents/skills/review/SKILL.md"),
      name: "review",
      path: "/repo/.agents/skills/review/SKILL.md",
    };
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project-1"),
      projectCwd: "/repo",
      threadId: "thread-1",
      commandId: "command-1",
      messageId: "message-1",
      createdAt: "2026-08-09T10:00:00.000Z",
      text: "Use $review",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      selectedSkills: [selectedSkill],
      workspaceMode: "local",
      branch: "main",
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });

    expect(input.selectedSkills).toEqual([selectedSkill]);
  });
});
