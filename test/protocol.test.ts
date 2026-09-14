import { describe, expect, it } from "vitest";

import { parseWebviewMessage } from "../src/preview/protocol";

describe("parseWebviewMessage", () => {
  it("accepts known messages with valid fields", () => {
    expect(parseWebviewMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(
      parseWebviewMessage({
        type: "revealSource",
        sourceId: "nav-1",
        generation: 4,
      }),
    ).toEqual({ type: "revealSource", sourceId: "nav-1", generation: 4 });
    expect(
      parseWebviewMessage({
        type: "previewScrolled",
        generation: 4,
        line: 12.5,
        fraction: 0.5,
      }),
    ).toEqual({
      type: "previewScrolled",
      generation: 4,
      line: 12.5,
      fraction: 0.5,
    });
    expect(
      parseWebviewMessage({
        type: "openLink",
        generation: 4,
        href: "../guide.md#start",
      }),
    ).toEqual({
      type: "openLink",
      generation: 4,
      href: "../guide.md#start",
    });
    expect(
      parseWebviewMessage({
        type: "replaceBlock",
        generation: 4,
        requestId: "edit-1",
        editId: "edit-0",
        replacement: "Updated.\n",
      }),
    ).toEqual({
      type: "replaceBlock",
      generation: 4,
      requestId: "edit-1",
      editId: "edit-0",
      replacement: "Updated.\n",
    });
    expect(
      parseWebviewMessage({
        type: "copyCode",
        generation: 4,
        requestId: "copy-1",
        code: "const value = 1;\n",
      }),
    ).toEqual({
      type: "copyCode",
      generation: 4,
      requestId: "copy-1",
      code: "const value = 1;\n",
    });
    expect(
      parseWebviewMessage({
        type: "toggleTask",
        generation: 4,
        requestId: "task-1",
        taskId: "task-0",
        checked: true,
      }),
    ).toEqual({
      type: "toggleTask",
      generation: 4,
      requestId: "task-1",
      taskId: "task-0",
      checked: true,
    });
    expect(
      parseWebviewMessage({
        type: "addComment",
        generation: 4,
        requestId: "comment-1",
        editId: "edit-0",
        quote: "selected text",
        quoteOccurrence: 1,
        quoteCount: 2,
        body: "Clarify this.",
      }),
    ).toEqual({
      type: "addComment",
      generation: 4,
      requestId: "comment-1",
      editId: "edit-0",
      quote: "selected text",
      quoteOccurrence: 1,
      quoteCount: 2,
      body: "Clarify this.",
    });
    expect(
      parseWebviewMessage({
        type: "updateComment",
        generation: 4,
        requestId: "comment-2",
        commentId: "c-1",
        action: "resolve",
      }),
    ).toEqual({
      type: "updateComment",
      generation: 4,
      requestId: "comment-2",
      commentId: "c-1",
      action: "resolve",
    });
  });

  it("rejects malformed or unknown messages", () => {
    expect(parseWebviewMessage(null)).toBeUndefined();
    expect(
      parseWebviewMessage({ type: "revealSource", sourceId: 1, generation: 4 }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "revealSource",
        sourceId: "nav-1",
        generation: -1,
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "previewScrolled",
        generation: 4,
        line: -1,
        fraction: 2,
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "openLink",
        generation: 4,
        href: "x".repeat(9000),
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "replaceBlock",
        generation: 4,
        requestId: "edit-1",
        editId: "edit-0",
        replacement: "x".repeat(1_000_001),
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "toggleTask",
        generation: 4,
        requestId: "task-1",
        taskId: "task-0",
        checked: "yes",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "copyCode",
        generation: 4,
        requestId: "copy-1",
        code: "x".repeat(1_000_001),
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "addComment",
        generation: 4,
        requestId: "comment-1",
        editId: "edit-0",
        quote: "selected",
        quoteOccurrence: 0,
        quoteCount: 1,
        body: "   ",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "updateComment",
        generation: 4,
        requestId: "comment-2",
        commentId: "c-1",
        action: "overwrite",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "runCommand",
        command: "workbench.action.closeWindow",
      }),
    ).toBeUndefined();
  });
});
