import sanitizeHtml from "sanitize-html";
import type Token from "markdown-it/lib/token.mjs";
import { randomUUID } from "node:crypto";
import {
  createCompatibilityRenderer,
  highlightCode,
  type CompatibilityOptions,
  type TrustedFragmentStore,
} from "./compatibility";
import { buildSourceIndex, type SourceIndex } from "./sourceIndex";

export const MAX_MARKDOWN_LENGTH = 2_000_000;

export interface RenderResult {
  html: string;
  sourceIndex: SourceIndex;
}

class RenderFragments implements TrustedFragmentStore {
  private readonly fragments = new Map<string, string>();
  private readonly prefix = `supermarkdown-fragment-${randomUUID()}-`;
  private nextId = 0;

  add(html: string): string {
    const id = `${this.prefix}${this.nextId++}`;
    this.fragments.set(id, html);
    return `<supermarkdown-fragment data-id="${id}"></supermarkdown-fragment>`;
  }

  restore(html: string): string {
    return html.replace(
      /<supermarkdown-fragment data-id="([^"]+)"><\/supermarkdown-fragment>/gu,
      (match, id: string) =>
        id.startsWith(this.prefix) ? (this.fragments.get(id) ?? "") : match,
    );
  }
}

function attachSourceIds(tokens: Token[], sourceIndex: SourceIndex): void {
  for (const anchor of sourceIndex.anchors) {
    const token = tokens.find(
      (candidate) =>
        candidate.map?.[0] === anchor.startLine &&
        candidate.map?.[1] === anchor.endLine &&
        (candidate.nesting === 1 ||
          ["fence", "html_block", "math_block"].includes(candidate.type)),
    );
    if (!token) {
      continue;
    }
    token.attrSet("data-source-id", anchor.id);
    token.attrSet("data-source-key", anchor.key);
    token.attrSet("data-source-line", String(anchor.startLine));
    token.attrSet("data-source-end-line", String(anchor.endLine));
  }

  for (const block of sourceIndex.editableBlocks) {
    const token = tokens.find(
      (candidate) =>
        candidate.map?.[0] === block.startLine &&
        candidate.map?.[1] === block.endLine &&
        (candidate.nesting === 1 ||
          candidate.type === "fence" ||
          candidate.type === "math_block"),
    );
    if (token) {
      token.attrSet("data-edit-id", block.id);
      token.attrSet("data-edit-type", block.type);
    }
  }

  for (const task of sourceIndex.taskMarkers) {
    const listItemIndex = tokens.findIndex(
      (candidate) =>
        candidate.type === "list_item_open" && candidate.map?.[0] === task.line,
    );
    if (listItemIndex < 0) {
      continue;
    }
    tokens[listItemIndex].attrSet("data-task-id", task.id);
    for (let index = listItemIndex + 1; index < tokens.length; index += 1) {
      if (tokens[index].type === "list_item_close") {
        break;
      }
      if (tokens[index].type !== "inline") {
        continue;
      }
      const checkbox = tokens[index].children?.find(
        (child) =>
          child.type === "html_inline" &&
          child.content.includes("task-list-item-checkbox"),
      );
      if (checkbox) {
        checkbox.content = checkbox.content
          .replace(" disabled", "")
          .replace(
            "task-list-item-checkbox",
            `task-list-item-checkbox\" data-task-id=\"${task.id}`,
          );
      }
      break;
    }
  }
}

async function highlightFences(
  tokens: Token[],
  fragments: RenderFragments,
): Promise<void> {
  await Promise.all(
    tokens.map(async (token) => {
      if (token.type !== "fence") {
        return;
      }
      const language = token.info.trim().split(/\s+/u)[0];
      if (language.toLowerCase() === "mermaid") {
        return;
      }
      token.meta ??= {};
      token.meta.supermarkdownHighlighted = await highlightCode(
        token.content,
        language,
        fragments,
      );
    }),
  );
}

function sanitizeRenderedHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img",
      "details",
      "summary",
      "del",
      "input",
      "section",
      "supermarkdown-fragment",
    ]),
    allowedAttributes: {
      "*": [
        "class",
        "id",
        "data-id",
        "data-source-id",
        "data-source-key",
        "data-source-line",
        "data-source-end-line",
        "data-edit-id",
        "data-edit-type",
        "data-task-id",
        "aria-label",
        "role",
      ],
      a: ["href", "name", "title"],
      img: ["src", "alt", "title", "width", "height"],
      input: ["type", "checked", "disabled", "data-task-id"],
      code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  });
}

export async function renderMarkdown(
  source: string,
  options: CompatibilityOptions = {},
): Promise<RenderResult> {
  if (source.length > MAX_MARKDOWN_LENGTH) {
    throw new Error(
      `Document exceeds the ${MAX_MARKDOWN_LENGTH.toLocaleString()} character safety limit.`,
    );
  }
  const fragments = new RenderFragments();
  const markdown = createCompatibilityRenderer(fragments, options);
  const environment: Record<string, unknown> = {};
  const tokens = markdown.parse(source, environment);
  const sourceIndex = buildSourceIndex(source, tokens);
  attachSourceIds(tokens, sourceIndex);
  await highlightFences(tokens, fragments);

  const rendered = markdown.renderer.render(
    tokens,
    markdown.options,
    environment,
  );
  const html = fragments.restore(sanitizeRenderedHtml(rendered));

  return { html, sourceIndex };
}
