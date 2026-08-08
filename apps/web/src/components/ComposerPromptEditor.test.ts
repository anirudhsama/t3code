import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  PASTE_COMMAND,
} from "lexical";
import { ProviderExtensionItemId } from "@t3tools/contracts";

import { registerComposerInlineTokenPaste } from "./composerInlineTokenPaste";
import {
  $createComposerSkillNodeForSkill,
  buildComposerSkillCatalog,
  ComposerSkillNode,
} from "./ComposerPromptEditor";

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;

  constructor(text: string) {
    super("paste", { cancelable: true });
    this.clipboardData = {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    } as unknown as DataTransfer;
  }
}

describe("registerComposerInlineTokenPaste", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles a copied mention without also running the plain-text paste fallback", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[improve-deploy-error-logging.md](.changeset/improve-deploy-error-logging.md)";
    const plainTextFallback = vi.fn(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(mention);
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:.changeset/improve-deploy-error-logging.md> ",
    );
  });

  it.each([
    "yarn expo install @expo/ui",
    "npm install @jane/foo.js",
    "import '@scope/pkg/sub/path'",
  ])("leaves scoped package command %s to the plain-text paste fallback", (command) => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const plainTextFallback = vi.fn((event: ClipboardEvent) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(event.clipboardData?.getData("text/plain") ?? "");
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(command);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).toHaveBeenCalledOnce();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(command);
  });

  it("pastes a canonical scoped folder link as a mention", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[sub](@scope/pkg/sub)";
    const plainTextFallback = vi.fn(() => true);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:@scope/pkg/sub> ",
    );
  });
});

describe("ComposerSkillNode", () => {
  const skill = {
    id: ProviderExtensionItemId.make("/repo/.agents/skills/review/SKILL.md"),
    name: "review",
    displayName: "Review",
    description: "Review this repository",
    scope: "project" as const,
    path: "/repo/.agents/skills/review/SKILL.md",
    providerEnabled: true,
    threadOverride: "inherit" as const,
    effectiveEnabled: true,
  };

  it("serializes v2 provider identity and keeps readable text", () => {
    const editor = createEditor({ nodes: [ComposerSkillNode] });
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createComposerSkillNodeForSkill(skill));
        $getRoot().append(paragraph);
      },
      { discrete: true },
    );

    expect(editor.getEditorState().toJSON()).toMatchObject({
      root: {
        children: [
          {
            children: [
              {
                type: "composer-skill",
                version: 2,
                skillId: skill.id,
                skillName: "review",
                skillPath: skill.path,
              },
            ],
          },
        ],
      },
    });
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe("$review");
  });

  it("continues decoding v1 name-only nodes", () => {
    const editor = createEditor({ nodes: [ComposerSkillNode] });
    const state = editor.parseEditorState({
      root: {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: "normal",
                style: "",
                skillName: "legacy-review",
                textFormat: 0,
                textStyle: "",
                type: "composer-skill",
                version: 1,
              },
            ],
            direction: null,
            format: "",
            indent: 0,
            type: "paragraph",
            version: 1,
            textFormat: 0,
            textStyle: "",
          },
        ],
        direction: null,
        format: "",
        indent: 0,
        type: "root",
        version: 1,
      },
    } as never);
    expect(state.read(() => $getRoot().getTextContent())).toBe("$legacy-review");
  });

  it("keeps an exact chip invalid when only a same-name skill at another path remains", () => {
    const editor = createEditor({ nodes: [ComposerSkillNode] });
    let exactId: string | null = null;
    let invalidReason: string | null = null;
    editor.update(
      () => {
        const node = $createComposerSkillNodeForSkill(skill);
        const paragraph = $createParagraphNode().append(node);
        $getRoot().append(paragraph);
        node.syncFromCatalog(
          buildComposerSkillCatalog([
            {
              ...skill,
              id: ProviderExtensionItemId.make("/home/user/.codex/skills/review/SKILL.md"),
              path: "/home/user/.codex/skills/review/SKILL.md",
              scope: "user",
            },
          ]),
        );
        exactId = node.getLatest().__skillId;
        invalidReason = node.getLatest().__invalidReason;
      },
      { discrete: true },
    );

    expect(exactId).toBe(skill.id);
    expect(invalidReason).toContain("no longer available");
  });

  it("marks an exact chip invalid when its thread-effective state becomes disabled", () => {
    const editor = createEditor({ nodes: [ComposerSkillNode] });
    let invalidReason: string | null = null;
    editor.update(
      () => {
        const node = $createComposerSkillNodeForSkill(skill);
        const paragraph = $createParagraphNode().append(node);
        $getRoot().append(paragraph);
        node.syncFromCatalog(
          buildComposerSkillCatalog([
            { ...skill, threadOverride: "disabled", effectiveEnabled: false },
          ]),
        );
        invalidReason = node.getLatest().__invalidReason;
      },
      { discrete: true },
    );

    expect(invalidReason).toContain("disabled for future turns");
  });

  it("does not rewrite a stale v2 path when a provider reuses the ID", () => {
    const editor = createEditor({ nodes: [ComposerSkillNode] });
    let path: string | null = null;
    let invalidReason: string | null = null;
    editor.update(
      () => {
        const node = $createComposerSkillNodeForSkill(skill);
        const paragraph = $createParagraphNode().append(node);
        $getRoot().append(paragraph);
        const movedCatalog = buildComposerSkillCatalog([
          { ...skill, path: "/repo/.agents/skills/moved/SKILL.md" },
        ]);
        node.syncFromCatalog(movedCatalog);
        node.syncFromCatalog(movedCatalog);
        path = node.getLatest().__skillPath;
        invalidReason = node.getLatest().__invalidReason;
      },
      { discrete: true },
    );

    expect(path).toBe(skill.path);
    expect(invalidReason).toContain("identity changed");
  });
});
