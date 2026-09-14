import { createHash, randomUUID } from "node:crypto";

export type CommentResolution = "open" | "resolved";
export type AnchorHealth = "attached" | "ambiguous" | "orphaned";

export interface TextQuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface CommentAnchor {
  health: AnchorHealth;
  start: number;
  end: number;
  lineHint: number;
  blockHash: string;
  quote: TextQuoteSelector;
}

export interface MarkdownComment {
  id: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  resolution: CommentResolution;
  anchor: CommentAnchor;
  body: string;
  displayQuote?: string;
}

export interface CommentSidecar {
  version: 1;
  source: {
    file: string;
    contentHash: string;
  };
  updatedAt: string;
  comments: MarkdownComment[];
}

export interface CreateCommentInput {
  source: string;
  sourceFile: string;
  start: number;
  end: number;
  lineHint: number;
  blockStart: number;
  blockEnd: number;
  body: string;
  author: string;
  displayQuote?: string;
  now?: string;
}

export function contentHash(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function createComment(input: CreateCommentInput): MarkdownComment {
  const now = input.now ?? new Date().toISOString();
  const exact = input.source.slice(input.start, input.end);
  return {
    id: `c-${randomUUID()}`,
    author: input.author,
    createdAt: now,
    updatedAt: now,
    resolution: "open",
    anchor: {
      health: "attached",
      start: input.start,
      end: input.end,
      lineHint: input.lineHint,
      blockHash: contentHash(
        input.source.slice(input.blockStart, input.blockEnd),
      ),
      quote: {
        exact,
        prefix: input.source.slice(
          Math.max(input.blockStart, input.start - 32),
          input.start,
        ),
        suffix: input.source.slice(
          input.end,
          Math.min(input.blockEnd, input.end + 32),
        ),
      },
    },
    body: input.body,
    ...(input.displayQuote && input.displayQuote !== exact
      ? { displayQuote: input.displayQuote }
      : {}),
  };
}

function allOccurrences(source: string, exact: string): number[] {
  if (!exact) {
    return [];
  }
  const positions: number[] = [];
  let offset = 0;
  while (offset <= source.length - exact.length) {
    const found = source.indexOf(exact, offset);
    if (found < 0) {
      break;
    }
    positions.push(found);
    offset = found + Math.max(exact.length, 1);
  }
  return positions;
}

function matchesContext(
  source: string,
  start: number,
  selector: TextQuoteSelector,
): boolean {
  const prefixStart = Math.max(0, start - selector.prefix.length);
  const suffixStart = start + selector.exact.length;
  return (
    source.slice(prefixStart, start).endsWith(selector.prefix) &&
    source
      .slice(suffixStart, suffixStart + selector.suffix.length)
      .startsWith(selector.suffix)
  );
}

export function reanchorComment(
  comment: MarkdownComment,
  source: string,
  lineAtOffset: (offset: number) => number,
): MarkdownComment {
  const selector = comment.anchor.quote;
  const occurrences = allOccurrences(source, selector.exact);
  const contextual = occurrences.filter((start) =>
    matchesContext(source, start, selector),
  );
  const candidates = contextual.length > 0 ? contextual : occurrences;
  if (candidates.length === 1) {
    const start = candidates[0];
    return {
      ...comment,
      anchor: {
        ...comment.anchor,
        health: "attached",
        start,
        end: start + selector.exact.length,
        lineHint: lineAtOffset(start),
      },
    };
  }

  return {
    ...comment,
    anchor: {
      ...comment.anchor,
      health: candidates.length > 1 ? "ambiguous" : "orphaned",
    },
  };
}

export function reanchorSidecar(
  sidecar: CommentSidecar,
  source: string,
  lineAtOffset: (offset: number) => number,
): CommentSidecar {
  return {
    ...sidecar,
    source: { ...sidecar.source, contentHash: contentHash(source) },
    comments: sidecar.comments.map((comment) =>
      reanchorComment(comment, source, lineAtOffset),
    ),
  };
}

export function emptySidecar(
  sourceFile: string,
  source: string,
): CommentSidecar {
  return {
    version: 1,
    source: { file: sourceFile, contentHash: contentHash(source) },
    updatedAt: new Date().toISOString(),
    comments: [],
  };
}
