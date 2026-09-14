import { MAX_MARKDOWN_LENGTH, renderMarkdown } from "../src/engine/renderer";
import { describe, expect, it } from "vitest";

describe("renderMarkdown", () => {
  it("rejects documents above the parser safety limit", async () => {
    await expect(
      renderMarkdown("x".repeat(MAX_MARKDOWN_LENGTH + 1)),
    ).rejects.toThrow("safety limit");
  });

  it("adds source identities to rendered blocks", async () => {
    const result = await renderMarkdown("# Heading\n\nParagraph.\n");

    expect(result.html).toContain('data-source-id="nav-0"');
    expect(result.html).toContain('data-source-id="nav-1"');
  });

  it("removes executable and UI-spoofing raw HTML", async () => {
    const result = await renderMarkdown(
      '<script>alert(1)</script>\n\n<form action="https://example.com"><input></form>\n',
    );

    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("<form");
    expect(result.html).not.toContain("action=");
  });

  it("does not turn unsafe URL schemes into links", async () => {
    const result = await renderMarkdown("[click](javascript:alert(1))\n");

    expect(result.html).not.toContain("<a ");
    expect(result.html).not.toContain('href="javascript:');
  });

  it("renders pinned GitHub-compatible syntax extensions", async () => {
    const result = await renderMarkdown(`
# Duplicate
# Duplicate
# [Linked heading](https://example.com)

> [!WARNING]
> Be careful.

- [ ] todo
- [x] done

1. [ ] numbered todo

Emoji: :rocket:

Footnote[^1].

[^1]: Footnote text.

Inline $x^2$. Currency $5 and $6 stays text.

$$
x = y + 1
$$
`);

    expect(result.html).toContain('id="duplicate"');
    expect(result.html).toContain('id="duplicate-1"');
    expect(result.html).toContain('id="linked-heading"');
    expect(result.html).toContain("markdown-alert-warning");
    expect(result.html).toContain("Be careful.");
    expect(result.html).toContain("task-list-item-checkbox");
    expect(result.html).toMatch(/<ol class="contains-task-list"[^>]*>/u);
    expect(result.html).toContain("checked");
    expect(result.html).toContain("🚀");
    expect(result.html).toContain("footnote-ref");
    expect(result.html).toContain("katex");
    expect(result.html).toContain("Currency $5 and $6 stays text.");
    expect(result.html).toContain("x = y + 1");
    expect(result.html).toMatch(
      /data-source-id="nav-\d+"[^>]*data-edit-type="math"[^>]*><span class="katex-display"/u,
    );
  });

  it("honors compatible line-break and front matter preview settings", async () => {
    const source = "---\ntitle: Example\n---\n\nfirst\nsecond\n";
    const table = await renderMarkdown(source, {
      breaks: true,
      frontMatter: "table",
    });
    const hidden = await renderMarkdown(source, { frontMatter: "hide" });
    const code = await renderMarkdown(source, { frontMatter: "codeBlock" });

    expect(table.html).toContain("<th>title</th><td>Example</td>");
    expect(table.html).toContain("first<br />\nsecond");
    expect(hidden.html).not.toContain("Example");
    expect(code.html).toContain('class="language-yaml"');
  });

  it("exposes only indexed edits and task controls", async () => {
    const result = await renderMarkdown(
      "# Heading\n\nStandalone paragraph.\n\n- [ ] task\n  - nested paragraph\n\n```ts\nconst x = 1;\n```\n",
    );

    expect(result.html).toContain('data-edit-type="heading"');
    expect(result.html).toContain('data-edit-type="paragraph"');
    expect(result.html).toContain('data-edit-type="list"');
    expect(result.html).toContain('data-edit-type="fence"');
    expect(result.html).toContain('data-task-id="task-0"');
    expect(result.html).toContain('input class="task-list-item-checkbox"');
    expect(result.html).not.toMatch(/task-list-item-checkbox[^>]*disabled/u);
    expect(result.sourceIndex.editableBlocks).toHaveLength(4);
    expect(result.sourceIndex.taskMarkers).toHaveLength(1);
  });

  it("pre-highlights known code and safely falls back for unknown languages", async () => {
    const result = await renderMarkdown(
      "```ts\nconst answer: number = 42;\n```\n\n```not-a-language\nplain <text>\n```\n",
    );

    expect(result.html).toContain('class="hljs language-ts"');
    expect(result.html).toContain('class="hljs-keyword"');
    expect(result.html).toContain('class="language-not-a-language"');
    expect(result.html).toContain("plain &lt;text&gt;");
  });

  it("does not restore author-supplied trusted-fragment placeholders", async () => {
    const result = await renderMarkdown(
      '<supermarkdown-fragment data-id="supermarkdown-fragment-0"></supermarkdown-fragment>\n\nInline $x^2$.\n',
    );

    expect(result.html).toContain('data-id="supermarkdown-fragment-0"');
    expect(result.html.match(/class="katex"/gu)).toHaveLength(1);
  });

  it("emits inert Mermaid source for strict client-side rendering", async () => {
    const result = await renderMarkdown(
      "```mermaid\ngraph TD\n  A --> B\n```\n",
    );

    expect(result.html).toContain('class="mermaid-diagram"');
    expect(result.html).toContain('class="mermaid-source"');
    expect(result.html).toMatch(
      /class="mermaid-diagram"[^>]*data-source-line="0"[^>]*data-source-end-line="4"/u,
    );
    expect(result.html).toContain("graph TD");
    expect(result.html).not.toContain("<svg");
    expect(result.html).not.toContain("<script");
  });
});
