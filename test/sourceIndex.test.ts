import { buildSourceIndex, hashSource } from "../src/engine/sourceIndex";
import { describe, expect, it } from "vitest";

import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: true });

function index(source: string) {
  return buildSourceIndex(source, markdown.parse(source, {}));
}

describe("buildSourceIndex", () => {
  it("maps standalone headings, paragraphs, and fences to exact source slices", () => {
    const source =
      "# Heading\n\nParagraph text.\n\n```ts\nconst value = 1;\n```\n";
    const result = index(source);

    expect(result.editableBlocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "fence",
    ]);
    expect(
      result.editableBlocks.map((block) =>
        source.slice(block.startOffset, block.endOffset),
      ),
    ).toEqual([
      "# Heading\n",
      "Paragraph text.\n",
      "```ts\nconst value = 1;\n```\n",
    ]);
    expect(result.editableBlocks[1].sourceHash).toBe(
      hashSource("Paragraph text.\n"),
    );
  });

  it("exposes whole top-level lists and blockquotes without nested edit targets", () => {
    const source = "- First item\n  - Nested item\n\n> Quoted paragraph\n";
    const result = index(source);

    expect(result.editableBlocks.map((block) => block.type)).toEqual([
      "list",
      "blockquote",
    ]);
    expect(
      result.editableBlocks.map((block) =>
        source.slice(block.startOffset, block.endOffset),
      ),
    ).toEqual(["- First item\n  - Nested item\n\n", "> Quoted paragraph\n"]);
  });

  it("preserves CRLF offsets and a final line without a newline", () => {
    const source = "# Heading\r\n\r\nFinal paragraph";
    const result = index(source);

    expect(
      result.editableBlocks.map((block) =>
        source.slice(block.startOffset, block.endOffset),
      ),
    ).toEqual(["# Heading\r\n", "Final paragraph"]);
  });

  it("deduplicates overlapping navigation ranges", () => {
    const source = "Paragraph with **emphasis**.\n";
    const result = index(source);

    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0]).toMatchObject({ startLine: 0, endLine: 1 });
  });

  it("indexes exact task markers inside editable list containers", () => {
    const source = "- [ ] first\n  - [x] nested\n10. [X] numbered\n";
    const result = index(source);

    expect(result.editableBlocks.map((block) => block.type)).toEqual([
      "list",
      "list",
    ]);
    expect(result.taskMarkers).toHaveLength(3);
    expect(
      result.taskMarkers.map((task) =>
        source.slice(task.markerOffset, task.markerOffset + 3),
      ),
    ).toEqual(["[ ]", "[x]", "[X]"]);
    expect(result.taskMarkers.map((task) => task.checked)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("uses content-based keys that survive inserted lines", () => {
    const original = index("# Heading\n\nStable paragraph.\n");
    const shifted = index(
      "Inserted paragraph.\n\n# Heading\n\nStable paragraph.\n",
    );

    expect(shifted.anchors.map((anchor) => anchor.key)).toEqual(
      expect.arrayContaining(original.anchors.map((anchor) => anchor.key)),
    );
  });

  it("exposes a whole table as one editable block", () => {
    const source = "| A | B |\n| - | - |\n| 1 | 2 |\n";
    const result = index(source);

    expect(result.editableBlocks.map((block) => block.type)).toEqual(["table"]);
    expect(
      source.slice(
        result.editableBlocks[0].startOffset,
        result.editableBlocks[0].endOffset,
      ),
    ).toBe(source);
  });
});
