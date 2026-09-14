export interface PreviewSettings {
  scrollEditorWithPreview: boolean;
  scrollPreviewWithEditor: boolean;
  preserveScrollOnUpdate: boolean;
  openMarkdownLinks: "editor" | "preview";
  breaks: boolean;
  linkify: boolean;
  typographer: boolean;
  frontMatter: "hide" | "codeBlock" | "table";
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  wordWrap: "off" | "on" | "wordWrapColumn" | "bounded";
  scrollBeyondLastLine: boolean;
}

export interface EditableBlockPayload {
  id: string;
  type:
    | "heading"
    | "paragraph"
    | "fence"
    | "math"
    | "table"
    | "list"
    | "blockquote";
  source: string;
}

export interface PreviewNotice {
  level: "info" | "warning" | "error";
  message: string;
}

export interface CommentPayload {
  id: string;
  editId?: string;
  resolution: "open" | "resolved";
  health: "attached" | "ambiguous" | "orphaned";
  quote: string;
  quoteOccurrence: number;
  body: string;
  author: string;
}

export interface RenderMessage {
  type: "render";
  uri: string;
  documentVersion: number;
  generation: number;
  html: string;
  editableBlocks: EditableBlockPayload[];
  comments: CommentPayload[];
  notices: PreviewNotice[];
  locked: boolean;
  settings: PreviewSettings;
}

export interface CommentsMessage {
  type: "comments";
  generation: number;
  comments: CommentPayload[];
  notices: PreviewNotice[];
}

export interface ScrollToLineMessage {
  type: "scrollToLine";
  generation: number;
  line: number;
  source: "editor";
}

export interface ImageChangedMessage {
  type: "imageChanged";
  generation: number;
  key: string;
  src: string;
}

export interface NavigateAnchorMessage {
  type: "navigateAnchor";
  generation: number;
  fragment: string;
}

export interface RevealSourceMessage {
  type: "revealSource";
  sourceId: string;
  generation: number;
}

export interface PreviewScrolledMessage {
  type: "previewScrolled";
  generation: number;
  line: number;
  fraction: number;
}

export interface OpenLinkMessage {
  type: "openLink";
  generation: number;
  href: string;
}

export interface ReplaceBlockMessage {
  type: "replaceBlock";
  generation: number;
  requestId: string;
  editId: string;
  replacement: string;
}

export interface ToggleTaskMessage {
  type: "toggleTask";
  generation: number;
  requestId: string;
  taskId: string;
  checked: boolean;
}

export interface CopyCodeResultMessage {
  type: "copyCodeResult";
  generation: number;
  requestId: string;
  applied: boolean;
  message?: string;
}

export interface CopyCodeMessage {
  type: "copyCode";
  generation: number;
  requestId: string;
  code: string;
}

export interface CommentResultMessage {
  type: "commentResult";
  generation: number;
  requestId: string;
  applied: boolean;
  message?: string;
}

export interface AddCommentMessage {
  type: "addComment";
  generation: number;
  requestId: string;
  editId: string;
  quote: string;
  quoteOccurrence: number;
  quoteCount: number;
  body: string;
}

export interface UpdateCommentMessage {
  type: "updateComment";
  generation: number;
  requestId: string;
  commentId: string;
  action: "resolve" | "reopen" | "delete";
}

export interface PreviewErrorMessage {
  type: "previewError";
  generation: number;
  message: string;
}

export interface EditResultMessage {
  type: "editResult";
  generation: number;
  requestId: string;
  applied: boolean;
  message?: string;
}

export interface WebviewErrorMessage {
  type: "webviewError";
  message: string;
  stack?: string;
}

export interface ReadyMessage {
  type: "ready";
}

export type ExtensionToWebviewMessage =
  | RenderMessage
  | CommentsMessage
  | ScrollToLineMessage
  | ImageChangedMessage
  | NavigateAnchorMessage
  | EditResultMessage
  | CopyCodeResultMessage
  | CommentResultMessage
  | PreviewErrorMessage;
export type WebviewToExtensionMessage =
  | ReadyMessage
  | RevealSourceMessage
  | PreviewScrolledMessage
  | OpenLinkMessage
  | ReplaceBlockMessage
  | ToggleTaskMessage
  | CopyCodeMessage
  | AddCommentMessage
  | UpdateCommentMessage
  | WebviewErrorMessage;

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

export function parseWebviewMessage(
  value: unknown,
): WebviewToExtensionMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const message = value as Record<string, unknown>;
  if (message.type === "ready") {
    return { type: "ready" };
  }
  if (
    message.type === "webviewError" &&
    typeof message.message === "string" &&
    message.message.length > 0 &&
    message.message.length <= 4096 &&
    (message.stack === undefined ||
      (typeof message.stack === "string" && message.stack.length <= 16_384))
  ) {
    return {
      type: "webviewError",
      message: message.message,
      stack: message.stack as string | undefined,
    };
  }
  if (
    message.type === "revealSource" &&
    typeof message.sourceId === "string" &&
    message.sourceId.length <= 128 &&
    validGeneration(message.generation)
  ) {
    return {
      type: "revealSource",
      sourceId: message.sourceId,
      generation: message.generation,
    };
  }
  if (
    message.type === "previewScrolled" &&
    validGeneration(message.generation) &&
    boundedNumber(message.line, 0, 10_000_000) &&
    boundedNumber(message.fraction, 0, 1)
  ) {
    return {
      type: "previewScrolled",
      generation: message.generation,
      line: message.line,
      fraction: message.fraction,
    };
  }
  if (
    message.type === "replaceBlock" &&
    validGeneration(message.generation) &&
    typeof message.requestId === "string" &&
    message.requestId.length > 0 &&
    message.requestId.length <= 128 &&
    typeof message.editId === "string" &&
    message.editId.length > 0 &&
    message.editId.length <= 128 &&
    typeof message.replacement === "string" &&
    message.replacement.length <= 1_000_000
  ) {
    return {
      type: "replaceBlock",
      generation: message.generation,
      requestId: message.requestId,
      editId: message.editId,
      replacement: message.replacement,
    };
  }
  if (
    message.type === "toggleTask" &&
    validGeneration(message.generation) &&
    typeof message.requestId === "string" &&
    message.requestId.length > 0 &&
    message.requestId.length <= 128 &&
    typeof message.taskId === "string" &&
    message.taskId.length > 0 &&
    message.taskId.length <= 128 &&
    typeof message.checked === "boolean"
  ) {
    return {
      type: "toggleTask",
      generation: message.generation,
      requestId: message.requestId,
      taskId: message.taskId,
      checked: message.checked,
    };
  }
  if (
    message.type === "copyCode" &&
    validGeneration(message.generation) &&
    typeof message.requestId === "string" &&
    message.requestId.length > 0 &&
    message.requestId.length <= 128 &&
    typeof message.code === "string" &&
    message.code.length <= 1_000_000
  ) {
    return {
      type: "copyCode",
      generation: message.generation,
      requestId: message.requestId,
      code: message.code,
    };
  }
  if (
    message.type === "addComment" &&
    validGeneration(message.generation) &&
    typeof message.requestId === "string" &&
    message.requestId.length > 0 &&
    message.requestId.length <= 128 &&
    typeof message.editId === "string" &&
    message.editId.length > 0 &&
    message.editId.length <= 128 &&
    typeof message.quote === "string" &&
    message.quote.length > 0 &&
    message.quote.length <= 100_000 &&
    Number.isSafeInteger(message.quoteOccurrence) &&
    (message.quoteOccurrence as number) >= 0 &&
    (message.quoteOccurrence as number) <= 100_000 &&
    Number.isSafeInteger(message.quoteCount) &&
    (message.quoteCount as number) > 0 &&
    (message.quoteCount as number) <= 100_000 &&
    typeof message.body === "string" &&
    message.body.trim().length > 0 &&
    message.body.length <= 100_000
  ) {
    return {
      type: "addComment",
      generation: message.generation,
      requestId: message.requestId,
      editId: message.editId,
      quote: message.quote,
      quoteOccurrence: message.quoteOccurrence as number,
      quoteCount: message.quoteCount as number,
      body: message.body,
    };
  }
  if (
    message.type === "updateComment" &&
    validGeneration(message.generation) &&
    typeof message.requestId === "string" &&
    message.requestId.length > 0 &&
    message.requestId.length <= 128 &&
    typeof message.commentId === "string" &&
    message.commentId.length > 0 &&
    message.commentId.length <= 128 &&
    ["resolve", "reopen", "delete"].includes(String(message.action))
  ) {
    return {
      type: "updateComment",
      generation: message.generation,
      requestId: message.requestId,
      commentId: message.commentId,
      action: message.action as "resolve" | "reopen" | "delete",
    };
  }
  if (
    message.type === "openLink" &&
    validGeneration(message.generation) &&
    typeof message.href === "string" &&
    message.href.length > 0 &&
    message.href.length <= 8192
  ) {
    return {
      type: "openLink",
      generation: message.generation,
      href: message.href,
    };
  }

  return undefined;
}
