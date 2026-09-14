import type { CommentSidecar, MarkdownComment } from "./model";

function string(value: unknown, maximum = 100_000): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function validComment(value: unknown): value is MarkdownComment {
  if (!value || typeof value !== "object") {
    return false;
  }
  const comment = value as Record<string, unknown>;
  const anchor = comment.anchor as Record<string, unknown> | undefined;
  const quote = anchor?.quote as Record<string, unknown> | undefined;
  return (
    string(comment.id, 128) &&
    string(comment.author, 256) &&
    string(comment.createdAt, 128) &&
    string(comment.updatedAt, 128) &&
    (comment.resolution === "open" || comment.resolution === "resolved") &&
    Boolean(anchor) &&
    ["attached", "ambiguous", "orphaned"].includes(String(anchor?.health)) &&
    Number.isSafeInteger(anchor?.start) &&
    (anchor?.start as number) >= 0 &&
    Number.isSafeInteger(anchor?.end) &&
    (anchor?.end as number) >= (anchor?.start as number) &&
    Number.isSafeInteger(anchor?.lineHint) &&
    (anchor?.lineHint as number) >= 0 &&
    string(anchor?.blockHash, 128) &&
    Boolean(quote) &&
    string(quote?.exact) &&
    string(quote?.prefix, 1024) &&
    string(quote?.suffix, 1024) &&
    string(comment.body) &&
    (comment.displayQuote === undefined || string(comment.displayQuote))
  );
}

export function parseSidecar(value: unknown): CommentSidecar | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const sidecar = value as Record<string, unknown>;
  const source = sidecar.source as Record<string, unknown> | undefined;
  if (
    sidecar.version !== 1 ||
    !source ||
    !string(source.file, 4096) ||
    !string(source.contentHash, 128) ||
    !string(sidecar.updatedAt, 128) ||
    !Array.isArray(sidecar.comments) ||
    sidecar.comments.length > 10_000 ||
    !sidecar.comments.every(validComment)
  ) {
    return undefined;
  }
  return sidecar as unknown as CommentSidecar;
}
