import {
  scrollToSourceLine,
  scrollToSourceLineAfterImages,
  sourcePositionAtViewport,
} from "./scrollSync";

import morphdom from "morphdom";
import {
  beginCommentFromSelection,
  decorateComments,
  handleCommentResult,
  showSelectionCommentButton,
  type AddCommentRequest,
  type CommentPayload,
  type UpdateCommentRequest,
} from "./comments";
import {
  decorateEditableBlocks,
  handleEditResult,
  openBlockEditor,
  type EditableBlockPayload,
} from "./editOverlay";
import { renderMermaidDiagrams } from "./mermaid";
import {
  decorateEditableTables,
  handleTableEditResult,
  openTableCellEditor,
  prepareEditableTablesForRefresh,
} from "./tableEditing";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};

interface PreviewSettings {
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

interface PreviewNotice {
  level: "info" | "warning" | "error";
  message: string;
}

interface RenderMessage {
  type: "render";
  uri: string;
  generation: number;
  html: string;
  editableBlocks: EditableBlockPayload[];
  comments: CommentPayload[];
  notices: PreviewNotice[];
  locked: boolean;
  settings: PreviewSettings;
}

interface CommentsMessage {
  type: "comments";
  generation: number;
  comments: CommentPayload[];
  notices: PreviewNotice[];
}

interface ScrollToLineMessage {
  type: "scrollToLine";
  generation: number;
  line: number;
}

interface EditResultMessage {
  type: "editResult";
  generation: number;
  requestId: string;
  applied: boolean;
  message?: string;
}

interface PreviewErrorMessage {
  type: "previewError";
  generation: number;
  message: string;
}

interface CopyCodeResultMessage {
  type: "copyCodeResult";
  generation: number;
  requestId: string;
  applied: boolean;
  message?: string;
}

interface CommentResultMessage {
  type: "commentResult";
  generation: number;
  requestId: string;
  applied: boolean;
  message?: string;
}

interface ImageChangedMessage {
  type: "imageChanged";
  generation: number;
  key: string;
  src: string;
}

interface NavigateAnchorMessage {
  type: "navigateAnchor";
  generation: number;
  fragment: string;
}

type HostMessage =
  | RenderMessage
  | CommentsMessage
  | ScrollToLineMessage
  | ImageChangedMessage
  | NavigateAnchorMessage
  | EditResultMessage
  | CopyCodeResultMessage
  | CommentResultMessage
  | PreviewErrorMessage;

interface PersistedState {
  uri?: string;
  locked?: boolean;
  generation?: number;
  scrollLine?: number;
}

const vscode = acquireVsCodeApi();
document.documentElement.dataset.supermarkdownReady = "true";
window.addEventListener("error", (event) => {
  vscode.postMessage({
    type: "webviewError",
    message: event.message || "Unknown webview error",
    stack: event.error instanceof Error ? event.error.stack : undefined,
  });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  vscode.postMessage({
    type: "webviewError",
    message:
      reason instanceof Error
        ? reason.message
        : `Unhandled webview rejection: ${String(reason)}`,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
const preview = document.querySelector<HTMLElement>("#preview");
const status = document.querySelector<HTMLElement>("#status");
let generation = -1;
let uri = "";
let locked = false;
let settings: PreviewSettings = {
  scrollEditorWithPreview: true,
  scrollPreviewWithEditor: true,
  preserveScrollOnUpdate: true,
  openMarkdownLinks: "preview",
  breaks: false,
  linkify: true,
  typographer: false,
  frontMatter: "table",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, sans-serif",
  fontSize: 14,
  lineHeight: 1.6,
  wordWrap: "on",
  scrollBeyondLastLine: true,
};
let suppressPreviewScrollUntil = 0;
let scrollFrame: number | undefined;
let editorScrollFrame: number | undefined;
let editorScrollRevision = 0;
const restoredState = vscode.getState() as PersistedState | undefined;
let restoredScrollLine = restoredState?.scrollLine;
let editableBlocks: EditableBlockPayload[] = [];
let nextTaskRequestId = 0;
const taskRequests = new Map<string, HTMLInputElement>();
let nextCopyRequestId = 0;
const copyRequests = new Map<string, HTMLButtonElement>();
let comments: CommentPayload[] = [];
let notices: PreviewNotice[] = [];

function sendAddComment(request: AddCommentRequest): void {
  vscode.postMessage({ type: "addComment", generation, ...request });
}

function sendUpdateComment(request: UpdateCommentRequest): void {
  vscode.postMessage({ type: "updateComment", generation, ...request });
}

function announce(message: string): void {
  if (!status) {
    return;
  }
  status.textContent = "";
  window.setTimeout(() => {
    status.textContent = message;
  }, 0);
}

function renderNotices(root: HTMLElement): void {
  root.querySelector(":scope > .preview-notices")?.remove();
  if (notices.length === 0) {
    return;
  }
  const container = document.createElement("aside");
  container.className = "preview-notices";
  container.setAttribute("aria-label", "Preview notices");
  for (const notice of notices) {
    const item = document.createElement("p");
    item.className = `preview-notice preview-notice-${notice.level}`;
    item.textContent = notice.message;
    container.append(item);
  }
  root.prepend(container);
}

function sendBlockEdit(request: {
  generation: number;
  requestId: string;
  editId: string;
  replacement: string;
}): void {
  vscode.postMessage({ type: "replaceBlock", ...request });
}

function persistedState(): PersistedState {
  return {
    uri,
    locked,
    generation,
    scrollLine: preview ? sourcePositionAtViewport(preview).line : 0,
  };
}

function applyPreviewSettings(): void {
  document.documentElement.style.setProperty(
    "--markdown-font-family",
    settings.fontFamily,
  );
  document.documentElement.style.setProperty(
    "--markdown-font-size",
    `${settings.fontSize}px`,
  );
  document.documentElement.style.setProperty(
    "--markdown-line-height",
    String(settings.lineHeight),
  );
  document.body.classList.toggle(
    "markdown-nowrap",
    settings.wordWrap === "off",
  );
  document.body.classList.toggle(
    "markdown-scroll-beyond-last-line",
    settings.scrollBeyondLastLine,
  );
}

function decorateCodeBlocks(root: HTMLElement): void {
  for (const code of Array.from(
    root.querySelectorAll<HTMLElement>("pre > code"),
  )) {
    const container = code.parentElement;
    if (
      !container ||
      container.querySelector(":scope > .markdown-copy-button")
    ) {
      continue;
    }
    container.classList.add("markdown-code-block");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "markdown-copy-button";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code block");
    button.addEventListener("click", () => {
      const requestId = `copy-${nextCopyRequestId++}`;
      button.disabled = true;
      copyRequests.set(requestId, button);
      vscode.postMessage({
        type: "copyCode",
        generation,
        requestId,
        code: code.textContent ?? "",
      });
    });
    container.append(button);
  }
}

function updatePreview(html: string): void {
  if (!preview) {
    return;
  }
  applyPreviewSettings();
  const previousPosition = settings.preserveScrollOnUpdate
    ? sourcePositionAtViewport(preview)
    : undefined;
  const target = preview.cloneNode(false) as HTMLElement;
  target.innerHTML = html;
  prepareEditableTablesForRefresh();
  morphdom(preview, target, {
    getNodeKey(node) {
      return node instanceof HTMLElement
        ? node.dataset.sourceKey || node.id || undefined
        : undefined;
    },
    onBeforeElUpdated(fromElement, toElement) {
      if (
        fromElement instanceof HTMLTableCellElement &&
        fromElement.classList.contains("editing-table-cell") &&
        fromElement.querySelector(".markdown-table-cell-input")
      ) {
        return false;
      }
      if (
        fromElement instanceof HTMLElement &&
        toElement instanceof HTMLElement &&
        fromElement.matches(".mermaid-output") &&
        fromElement.closest<HTMLElement>(".mermaid-diagram")?.dataset
          .sourceKey ===
          toElement.closest<HTMLElement>(".mermaid-diagram")?.dataset
            .sourceKey &&
        fromElement.querySelector("svg")
      ) {
        return false;
      }
      if (
        fromElement instanceof HTMLDetailsElement &&
        toElement instanceof HTMLDetailsElement
      ) {
        toElement.open = fromElement.open;
      }
      return true;
    },
  });
  renderNotices(preview);
  decorateCodeBlocks(preview);
  decorateEditableBlocks(preview, editableBlocks, generation, sendBlockEdit);
  decorateComments(preview, comments, sendUpdateComment);
  decorateEditableTables(preview, editableBlocks, generation, sendBlockEdit);
  void renderMermaidDiagrams(preview, generation);
  const targetLine = previousPosition?.line ?? restoredScrollLine;
  if (targetLine !== undefined) {
    suppressPreviewScrollUntil = Date.now() + 150;
    scrollToSourceLine(preview, targetLine);
    restoredScrollLine = undefined;
  }
}

function navigateAnchor(fragment: string): void {
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // Use the literal fragment when decoding fails.
  }
  const element = document.getElementById(decoded);
  if (element) {
    suppressPreviewScrollUntil = Date.now() + 150;
    element.scrollIntoView({ block: "start" });
  }
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!event.data || typeof event.data !== "object" || !preview) {
    return;
  }
  const message = event.data as Partial<HostMessage>;
  if (message.type === "render") {
    if (
      typeof message.generation !== "number" ||
      typeof message.html !== "string" ||
      typeof message.uri !== "string" ||
      !Array.isArray(message.editableBlocks) ||
      !Array.isArray(message.comments) ||
      !Array.isArray(message.notices) ||
      typeof message.locked !== "boolean" ||
      !message.settings ||
      message.generation < generation
    ) {
      return;
    }
    generation = message.generation;
    uri = message.uri;
    locked = message.locked;
    editableBlocks = message.editableBlocks;
    comments = message.comments;
    notices = message.notices;
    settings = message.settings;
    updatePreview(message.html);
    vscode.setState(persistedState());
    return;
  }
  if (
    message.type === "previewError" &&
    typeof message.generation === "number" &&
    typeof message.message === "string"
  ) {
    if (message.generation < generation) {
      return;
    }
    generation = message.generation;
    notices = [{ level: "error", message: message.message }];
    renderNotices(preview);
    announce(message.message);
    return;
  }
  if (
    message.type === "commentResult" &&
    typeof message.requestId === "string" &&
    typeof message.applied === "boolean"
  ) {
    // Request IDs are unique, so a reply is always safe to apply even if a
    // newer render arrived while the request was in flight.
    handleCommentResult(message.requestId, message.applied, message.message);
    announce(
      message.applied
        ? "Comment updated."
        : (message.message ?? "Could not update comment."),
    );
    return;
  }
  if (message.generation !== generation) {
    return;
  }
  if (
    message.type === "comments" &&
    Array.isArray(message.comments) &&
    Array.isArray(message.notices)
  ) {
    comments = message.comments;
    notices = message.notices;
    renderNotices(preview);
    decorateComments(preview, comments, sendUpdateComment);
  } else if (
    message.type === "imageChanged" &&
    typeof message.key === "string" &&
    typeof message.src === "string"
  ) {
    const selector = `[data-supermarkdown-image-key="${CSS.escape(message.key)}"]`;
    for (const element of Array.from(
      preview.querySelectorAll<HTMLElement>(selector),
    )) {
      if (element instanceof HTMLImageElement) {
        element.src = message.src;
      } else {
        const image = document.createElement("img");
        image.src = message.src;
        image.alt = element.dataset.imageAlt ?? "";
        image.dataset.supermarkdownImageKey = message.key;
        element.replaceWith(image);
      }
    }
  } else if (
    message.type === "scrollToLine" &&
    typeof message.line === "number" &&
    settings.scrollPreviewWithEditor
  ) {
    const revision = ++editorScrollRevision;
    if (editorScrollFrame !== undefined) {
      window.cancelAnimationFrame(editorScrollFrame);
    }
    editorScrollFrame = window.requestAnimationFrame(() => {
      editorScrollFrame = undefined;
      suppressPreviewScrollUntil = Date.now() + 150;
      void scrollToSourceLineAfterImages(
        preview,
        message.line!,
        () => revision === editorScrollRevision,
      );
    });
  } else if (
    message.type === "editResult" &&
    typeof message.requestId === "string" &&
    typeof message.applied === "boolean"
  ) {
    const task = taskRequests.get(message.requestId);
    if (task) {
      taskRequests.delete(message.requestId);
      task.disabled = false;
      if (!message.applied) {
        task.checked = !task.checked;
        task.title = message.message ?? "Could not update task.";
      }
      announce(
        message.applied
          ? `Task marked ${task.checked ? "complete" : "incomplete"}.`
          : (message.message ?? "Could not update task."),
      );
    } else if (
      handleTableEditResult(
        message.requestId,
        message.applied,
        message.message,
        sendBlockEdit,
      )
    ) {
      announce(
        message.applied
          ? "Table cell updated."
          : (message.message ?? "Could not update table cell."),
      );
    } else {
      handleEditResult(message.requestId, message.applied, message.message);
      announce(
        message.applied
          ? "Markdown block updated."
          : (message.message ?? "Could not update Markdown block."),
      );
    }
  } else if (
    message.type === "copyCodeResult" &&
    typeof message.requestId === "string" &&
    typeof message.applied === "boolean"
  ) {
    const button = copyRequests.get(message.requestId);
    if (button) {
      copyRequests.delete(message.requestId);
      button.disabled = false;
      button.textContent = message.applied ? "Copied" : "Copy";
      if (!message.applied) {
        button.title = message.message ?? "Could not copy code.";
      }
      announce(message.applied ? "Code copied to clipboard." : button.title);
      window.setTimeout(() => {
        if (button.isConnected) {
          button.textContent = "Copy";
        }
      }, 1500);
    }
  } else if (
    message.type === "navigateAnchor" &&
    typeof message.fragment === "string"
  ) {
    navigateAnchor(message.fragment);
  }
});

preview?.addEventListener("click", (event) => {
  const target = event.target;
  if (
    !(target instanceof Element) ||
    target.closest(".markdown-table-cell-input")
  ) {
    return;
  }
  const cell = target.closest<HTMLTableCellElement>(
    'table[data-edit-type="table"] th.markdown-editable-table-cell, table[data-edit-type="table"] td.markdown-editable-table-cell',
  );
  if (cell && openTableCellEditor(cell, sendBlockEdit)) {
    event.preventDefault();
    event.stopPropagation();
  }
});

preview?.addEventListener("dblclick", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (target.closest(".markdown-table-cell-input")) {
    return;
  }
  const cell = target.closest<HTMLTableCellElement>(
    'table[data-edit-type="table"] th, table[data-edit-type="table"] td',
  );
  if (cell && openTableCellEditor(cell, sendBlockEdit)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const block = target.closest<HTMLElement>("[data-source-id]");
  if (block?.dataset.editId && openBlockEditor(block, sendBlockEdit)) {
    event.preventDefault();
    return;
  }
  const sourceId = block?.dataset.sourceId;
  if (sourceId) {
    vscode.postMessage({ type: "revealSource", sourceId, generation });
  }
});

preview?.addEventListener("mouseup", () => {
  window.setTimeout(
    () => showSelectionCommentButton(preview, sendAddComment),
    0,
  );
});

preview?.addEventListener("contextmenu", (event) => {
  if (beginCommentFromSelection(preview, sendAddComment)) {
    event.preventDefault();
  }
});

preview?.addEventListener(
  "error",
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) {
      return;
    }
    const replacement = document.createElement("span");
    replacement.className = "image-load-error";
    replacement.setAttribute("role", "img");
    if (target.dataset.supermarkdownImageKey) {
      replacement.dataset.supermarkdownImageKey =
        target.dataset.supermarkdownImageKey;
      replacement.dataset.imageAlt = target.alt;
    }
    replacement.setAttribute(
      "aria-label",
      target.alt || "Image failed to load",
    );
    replacement.textContent = target.alt
      ? `[Image unavailable: ${target.alt}]`
      : "[Image unavailable]";
    target.replaceWith(replacement);
    announce(replacement.textContent);
  },
  true,
);

preview?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  const target = event.target;
  if (!(target instanceof HTMLTableCellElement)) {
    return;
  }
  if (openTableCellEditor(target, sendBlockEdit)) {
    event.preventDefault();
    event.stopPropagation();
  }
});

preview?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const checkbox = target.closest<HTMLInputElement>(
    "input.task-list-item-checkbox[data-task-id]",
  );
  if (checkbox) {
    const requestId = `task-${nextTaskRequestId++}`;
    taskRequests.set(requestId, checkbox);
    checkbox.disabled = true;
    vscode.postMessage({
      type: "toggleTask",
      generation,
      requestId,
      taskId: checkbox.dataset.taskId,
      checked: checkbox.checked,
    });
    return;
  }
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (!link) {
    return;
  }
  event.preventDefault();
  vscode.postMessage({
    type: "openLink",
    href: link.getAttribute("href"),
    generation,
  });
});

window.addEventListener(
  "scroll",
  () => {
    if (
      !preview ||
      !settings.scrollEditorWithPreview ||
      Date.now() < suppressPreviewScrollUntil
    ) {
      return;
    }
    if (scrollFrame !== undefined) {
      return;
    }
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = undefined;
      const position = sourcePositionAtViewport(preview);
      vscode.postMessage({
        type: "previewScrolled",
        generation,
        line: position.line,
        fraction: position.fraction,
      });
      vscode.setState(persistedState());
    });
  },
  { passive: true },
);

vscode.postMessage({ type: "ready" });
