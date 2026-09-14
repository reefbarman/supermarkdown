import { describe, expect, it } from "vitest";

import { replaceMarkdownTableCell } from "../webview/tableEditing";

describe("replaceMarkdownTableCell", () => {
  it("updates header and body cells without rewriting the table", () => {
    const source =
      "| Name | Value |\n| :--- | ---: |\n| Alpha | 1 |\n| Beta | 2 |\n";

    expect(replaceMarkdownTableCell(source, 0, 1, "Amount")).toBe(
      "| Name | Amount |\n| :--- | ---: |\n| Alpha | 1 |\n| Beta | 2 |\n",
    );
    expect(replaceMarkdownTableCell(source, 2, 0, "Second")).toBe(
      "| Name | Value |\n| :--- | ---: |\n| Alpha | 1 |\n| Second | 2 |\n",
    );
  });

  it("escapes entered pipes and preserves escaped pipes in other cells", () => {
    const source = "Name | Detail\n--- | ---\nA | existing \\| value\n";

    expect(replaceMarkdownTableCell(source, 1, 0, "B | C")).toBe(
      "Name | Detail\n--- | ---\nB \\| C | existing \\| value\n",
    );
  });

  it("fills an omitted body cell and preserves CRLF endings", () => {
    const source = "| A | B |\r\n| --- | --- |\r\n| one |\r\n";

    expect(replaceMarkdownTableCell(source, 1, 1, "two")).toBe(
      "| A | B |\r\n| --- | --- |\r\n| one | two |\r\n",
    );
  });

  it("keeps a trailing literal backslash separate from the next cell", () => {
    const source = "A|B\n---|---\none|two\n";

    expect(replaceMarkdownTableCell(source, 1, 0, "path\\")).toBe(
      "A|B\n---|---\npath\\\\ |two\n",
    );
    expect(
      replaceMarkdownTableCell("A|B\n---|---\npath\\\\ |two\n", 1, 1, "next"),
    ).toBe("A|B\n---|---\npath\\\\ |next\n");
  });

  it("rejects cells that cannot map to table source", () => {
    const source = "| A |\n| --- |\n";

    expect(replaceMarkdownTableCell(source, -1, 0, "x")).toBeUndefined();
    expect(replaceMarkdownTableCell(source, 2, 0, "x")).toBeUndefined();
  });
});
