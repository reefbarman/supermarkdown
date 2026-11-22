import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";
import type Renderer from "markdown-it/lib/renderer.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import { full as emoji } from "markdown-it-emoji";
import footnote from "markdown-it-footnote";
import hljs from "highlight.js/lib/common";
import katex from "katex";

const ALERT_TYPES = new Set(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]);

export interface TrustedFragmentStore {
  add(html: string): string;
}

export interface CompatibilityOptions {
  breaks?: boolean;
  linkify?: boolean;
  typographer?: boolean;
  frontMatter?: "hide" | "codeBlock" | "table";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function headingText(token: Token): string {
  if (token.type === "text" || token.type === "code_inline") {
    return token.content;
  }
  if (token.type === "image") {
    return token.content;
  }
  return token.children?.map(headingText).join("") ?? "";
}

function frontMatter(
  markdown: MarkdownIt,
  mode: NonNullable<CompatibilityOptions["frontMatter"]>,
): void {
  markdown.block.ruler.before(
    "hr",
    "supermarkdown_front_matter",
    (state, startLine, endLine, silent) => {
      if (startLine !== 0) {
        return false;
      }
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const maximum = state.eMarks[startLine];
      if (state.src.slice(start, maximum).trim() !== "---") {
        return false;
      }
      let nextLine = startLine + 1;
      while (nextLine < endLine) {
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const line = state.src.slice(lineStart, state.eMarks[nextLine]).trim();
        if (line === "---") {
          if (silent) {
            return true;
          }
          const token = state.push("front_matter", "", 0);
          token.block = true;
          token.content = state.getLines(startLine + 1, nextLine, 0, false);
          token.map = [startLine, nextLine + 1];
          state.line = nextLine + 1;
          return true;
        }
        nextLine += 1;
      }
      return false;
    },
  );

  markdown.renderer.rules.front_matter = (
    tokens,
    index,
    _options,
    _environment,
    renderer,
  ) => {
    if (mode === "hide") {
      return "";
    }
    const token = tokens[index];
    const attrs = renderer.renderAttrs(token);
    if (mode === "codeBlock") {
      return `<pre${attrs}><code class="language-yaml">${escapeHtml(token.content)}</code></pre>\n`;
    }
    const rows = token.content
      .split(/\r?\n/u)
      .map((line) => /^\s*([^:#][^:]*):\s*(.*)$/u.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map(
        (match) =>
          `<tr><th>${escapeHtml(match[1].trim())}</th><td>${escapeHtml(match[2].trim())}</td></tr>`,
      )
      .join("");
    return rows ? `<table${attrs}><tbody>${rows}</tbody></table>\n` : "";
  };
}

function headingAnchors(markdown: MarkdownIt): void {
  markdown.core.ruler.push("supermarkdown_heading_anchors", (state) => {
    const slugger = new GithubSlugger();
    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token.type !== "heading_open") {
        continue;
      }
      const inline = state.tokens[index + 1];
      if (inline?.type === "inline") {
        token.attrSet(
          "id",
          slugger.slug(
            inline.children?.map(headingText).join("") ?? inline.content,
          ),
        );
      }
    }
  });
}

function alerts(markdown: MarkdownIt): void {
  markdown.core.ruler.push("supermarkdown_alerts", (state) => {
    for (let index = 0; index < state.tokens.length - 2; index += 1) {
      const open = state.tokens[index];
      const paragraph = state.tokens[index + 1];
      const inline = state.tokens[index + 2];
      if (
        open.type !== "blockquote_open" ||
        paragraph.type !== "paragraph_open" ||
        inline.type !== "inline"
      ) {
        continue;
      }

      const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|$)/.exec(
        inline.content,
      );
      if (!match || !ALERT_TYPES.has(match[1])) {
        continue;
      }

      const type = match[1].toLowerCase();
      open.attrJoin("class", `markdown-alert markdown-alert-${type}`);
      inline.content = inline.content.slice(match[0].length);
      inline.children = [];
      state.md.inline.parse(
        inline.content,
        state.md,
        state.env,
        inline.children,
      );

      const title = new state.Token("html_block", "", 0);
      title.content = `<p class="markdown-alert-title">${escapeHtml(
        match[1][0] + match[1].slice(1).toLowerCase(),
      )}</p>\n`;
      state.tokens.splice(index + 1, 0, title);
      index += 1;
    }
  });
}

function taskLists(markdown: MarkdownIt): void {
  markdown.core.ruler.after("inline", "supermarkdown_task_lists", (state) => {
    for (let index = 2; index < state.tokens.length; index += 1) {
      const inline = state.tokens[index];
      if (
        inline.type !== "inline" ||
        state.tokens[index - 1].type !== "paragraph_open" ||
        state.tokens[index - 2].type !== "list_item_open"
      ) {
        continue;
      }
      const match = /^\[([ xX])\]\s+/.exec(inline.content);
      if (!match) {
        continue;
      }

      inline.content = inline.content.slice(match[0].length);
      inline.children = [];
      state.md.inline.parse(
        inline.content,
        state.md,
        state.env,
        inline.children,
      );
      const checkbox = new state.Token("html_inline", "", 0);
      checkbox.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${
        match[1] === " " ? "" : " checked"
      }>`;
      inline.children.unshift(checkbox);
      state.tokens[index - 2].attrJoin("class", "task-list-item");

      for (let parent = index - 3; parent >= 0; parent -= 1) {
        if (
          state.tokens[parent].type === "bullet_list_open" ||
          state.tokens[parent].type === "ordered_list_open"
        ) {
          const classes =
            state.tokens[parent].attrGet("class")?.split(/\s+/u) ?? [];
          if (!classes.includes("contains-task-list")) {
            state.tokens[parent].attrJoin("class", "contains-task-list");
          }
          break;
        }
        if (
          state.tokens[parent].type === "bullet_list_close" ||
          state.tokens[parent].type === "ordered_list_close"
        ) {
          break;
        }
      }
    }
  });
}

function math(markdown: MarkdownIt, fragments: TrustedFragmentStore): void {
  markdown.inline.ruler.after(
    "escape",
    "supermarkdown_math_inline",
    (state: StateInline, silent: boolean): boolean => {
      if (
        state.src[state.pos] !== "$" ||
        state.src[state.pos + 1] === "$" ||
        (state.pos > 0 && state.src[state.pos - 1] === "\\")
      ) {
        return false;
      }
      const end = state.src.indexOf("$", state.pos + 1);
      if (
        end < 0 ||
        end === state.pos + 1 ||
        state.src[end - 1] === "\\" ||
        /\s/u.test(state.src[state.pos + 1]) ||
        /\s/u.test(state.src[end - 1]) ||
        (/\d/u.test(state.src[state.pos + 1]) && /\d/u.test(state.src[end - 1]))
      ) {
        return false;
      }
      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = state.src.slice(state.pos + 1, end);
      }
      state.pos = end + 1;
      return true;
    },
  );

  markdown.block.ruler.before(
    "fence",
    "supermarkdown_math_block",
    (
      state: StateBlock,
      startLine: number,
      endLine: number,
      silent: boolean,
    ): boolean => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const maximum = state.eMarks[startLine];
      const firstLine = state.src.slice(start, maximum).trim();
      if (!firstLine.startsWith("$$")) {
        return false;
      }
      if (silent) {
        return true;
      }

      let nextLine = startLine;
      let content = firstLine.slice(2);
      if (content.endsWith("$$") && content.length > 2) {
        content = content.slice(0, -2);
      } else {
        const lines: string[] = [content];
        let closed = false;
        while (++nextLine < endLine) {
          const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
          const line = state.src.slice(lineStart, state.eMarks[nextLine]);
          if (line.trimEnd().endsWith("$$")) {
            lines.push(line.trimEnd().slice(0, -2));
            closed = true;
            break;
          }
          lines.push(line);
        }
        if (!closed) {
          return false;
        }
        content = lines.join("\n");
      }

      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.content = content.trim();
      token.map = [startLine, nextLine + 1];
      state.line = nextLine + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );

  markdown.renderer.rules.math_inline = (tokens, index) =>
    fragments.add(
      katex.renderToString(tokens[index].content, {
        displayMode: false,
        output: "htmlAndMathml",
        throwOnError: false,
        strict: "warn",
      }),
    );
  markdown.renderer.rules.math_block = (
    tokens,
    index,
    options,
    _environment,
    renderer,
  ) =>
    `<div${renderer.renderAttrs(tokens[index])}>${fragments.add(
      katex.renderToString(tokens[index].content, {
        displayMode: true,
        output: "htmlAndMathml",
        throwOnError: false,
        strict: "warn",
      }),
    )}</div>\n`;
}

function mermaidFence(
  tokens: Token[],
  index: number,
  options: Parameters<Renderer["renderToken"]>[2],
  environment: unknown,
  renderer: Renderer,
): string | undefined {
  const token = tokens[index];
  if (token.info.trim().split(/\s+/u)[0].toLowerCase() !== "mermaid") {
    return undefined;
  }
  const attrs = renderer.renderAttrs(token);
  return `<div class="mermaid-diagram"${attrs}><pre class="mermaid-source">${escapeHtml(
    token.content,
  )}</pre><div class="mermaid-output" role="img" aria-label="Mermaid diagram"></div></div>\n`;
}

export function createCompatibilityRenderer(
  fragments: TrustedFragmentStore,
  options: CompatibilityOptions = {},
): MarkdownIt {
  const markdown = new MarkdownIt({
    html: true,
    breaks: options.breaks ?? false,
    linkify: options.linkify ?? true,
    typographer: options.typographer ?? false,
  });

  frontMatter(markdown, options.frontMatter ?? "table");
  markdown.use(emoji);
  markdown.use(footnote);
  headingAnchors(markdown);
  alerts(markdown);
  taskLists(markdown);
  math(markdown, fragments);

  // Match GitHub's table output without allowing raw HTML styles through the sanitizer.
  markdown.core.ruler.push("table_alignment", ({ tokens }) => {
    for (const token of tokens) {
      if (token.type !== "th_open" && token.type !== "td_open") {
        continue;
      }
      const style = token.attrs?.find((attribute) => attribute[0] === "style");
      const alignment = style?.[1].match(
        /^text-align:(left|center|right)$/u,
      )?.[1];
      if (style && alignment) {
        style[0] = "align";
        style[1] = alignment;
      }
    }
  });

  const defaultFence = markdown.renderer.rules.fence?.bind(
    markdown.renderer.rules,
  );
  markdown.renderer.rules.fence = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    const mermaid = mermaidFence(tokens, index, options, environment, renderer);
    if (mermaid) {
      return mermaid;
    }

    const highlighted = tokens[index].meta?.supermarkdownHighlighted;
    if (typeof highlighted === "string") {
      return `<div${renderer.renderAttrs(tokens[index])}>${highlighted}</div>\n`;
    }

    return defaultFence
      ? defaultFence(tokens, index, options, environment, renderer)
      : renderer.renderToken(tokens, index, options);
  };

  return markdown;
}

export async function highlightCode(
  code: string,
  language: string,
  fragments: TrustedFragmentStore,
): Promise<string> {
  const normalized = language.trim().split(/\s+/u)[0] || "text";
  if (!hljs.getLanguage(normalized)) {
    return `<pre><code class="language-${escapeHtml(normalized)}">${escapeHtml(code)}</code></pre>`;
  }

  try {
    const highlighted = hljs.highlight(code, {
      language: normalized,
      ignoreIllegals: true,
    });
    return fragments.add(
      `<pre><code class="hljs language-${escapeHtml(normalized)}">${highlighted.value}</code></pre>`,
    );
  } catch {
    return `<pre><code class="language-${escapeHtml(normalized)}">${escapeHtml(code)}</code></pre>`;
  }
}
