import { activateModal, type ModalHandle } from "./accessibility";

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

export interface AddCommentRequest {
  requestId: string;
  editId: string;
  quote: string;
  quoteOccurrence: number;
  quoteCount: number;
  body: string;
}

export interface UpdateCommentRequest {
  requestId: string;
  commentId: string;
  action: "resolve" | "reopen" | "delete";
}

interface PendingComposer {
  requestId: string;
  dialog: HTMLElement;
  body: HTMLTextAreaElement;
  add: HTMLButtonElement;
  status: HTMLElement;
}

const pending = new Map<string, PendingComposer>();
const pendingActions = new Map<
  string,
  { button: HTMLButtonElement; action: UpdateCommentRequest["action"] }
>();
let nextRequestId = 0;
let activeComposer: HTMLElement | undefined;
let selectionButton: HTMLButtonElement | undefined;
let composerModal: ModalHandle | undefined;
let pendingFocusEditId: string | undefined;

function removeExisting(root: HTMLElement): void {
  for (const marker of Array.from(
    root.querySelectorAll<HTMLElement>(".markdown-comment-marker"),
  )) {
    marker.remove();
  }
  for (const highlight of Array.from(
    root.querySelectorAll<HTMLElement>("mark.markdown-comment-highlight"),
  )) {
    highlight.replaceWith(document.createTextNode(highlight.textContent ?? ""));
  }
  root.normalize();
  root.querySelector(":scope > .markdown-comment-tray")?.remove();
  for (const block of Array.from(
    root.querySelectorAll<HTMLElement>(".has-markdown-comments"),
  )) {
    block.classList.remove("has-markdown-comments");
    block.removeAttribute("data-open-comment-count");
  }
}

function textSnapshot(block: HTMLElement): { nodes: Text[]; text: string } {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest(
        ".markdown-comment-marker, .markdown-edit-button",
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    nodes.push(node);
    text += node.data;
  }
  return { nodes, text };
}

function occurrenceOffset(
  text: string,
  quote: string,
  occurrence: number,
): number {
  let start = -1;
  let searchOffset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = text.indexOf(quote, searchOffset);
    if (start < 0) {
      return -1;
    }
    searchOffset = start + quote.length;
  }
  return start;
}

interface HighlightGroup {
  comments: CommentPayload[];
  end: number;
  marks: HTMLElement[];
  start: number;
}

function highlightQuotes(
  block: HTMLElement,
  comments: CommentPayload[],
): HighlightGroup[] {
  const { nodes, text } = textSnapshot(block);
  const ranges = comments
    .filter((comment) => comment.health === "attached" && comment.quote)
    .map((comment) => {
      const start = occurrenceOffset(
        text,
        comment.quote,
        comment.quoteOccurrence,
      );
      return {
        start,
        end: start + comment.quote.length,
        comments: [comment],
        marks: [] as HTMLElement[],
      };
    })
    .filter((range) => range.start >= 0)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: HighlightGroup[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      previous.comments.push(...range.comments);
    } else {
      merged.push({ ...range });
    }
  }

  let offset = 0;
  for (const node of nodes) {
    const nodeStart = offset;
    const nodeEnd = offset + node.data.length;
    offset = nodeEnd;
    const pieces: Node[] = [];
    let localOffset = 0;
    for (const range of merged) {
      const localStart = Math.max(0, range.start - nodeStart);
      const localEnd = Math.min(node.data.length, range.end - nodeStart);
      if (localStart >= localEnd) {
        continue;
      }
      pieces.push(
        document.createTextNode(node.data.slice(localOffset, localStart)),
      );
      const mark = document.createElement("mark");
      mark.className = "markdown-comment-highlight";
      if (
        range.comments.every((comment) => comment.resolution === "resolved")
      ) {
        mark.classList.add("markdown-comment-highlight-resolved");
      }
      mark.textContent = node.data.slice(localStart, localEnd);
      range.marks.push(mark);
      pieces.push(mark);
      localOffset = localEnd;
    }
    if (pieces.length > 0) {
      pieces.push(document.createTextNode(node.data.slice(localOffset)));
      node.replaceWith(...pieces);
    }
  }
  return merged;
}

function confirmDelete(onConfirm: () => void): void {
  const backdrop = document.createElement("div");
  backdrop.className = "markdown-comment-backdrop";
  const dialog = document.createElement("section");
  dialog.className = "markdown-comment-composer";
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Delete comment");
  const title = document.createElement("strong");
  title.textContent = "Delete comment?";
  const message = document.createElement("p");
  message.textContent =
    "This permanently removes the comment from the sidecar.";
  const controls = document.createElement("div");
  controls.className = "markdown-comment-controls";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Delete";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  controls.append(remove, cancel);
  dialog.append(title, message, controls);
  backdrop.append(dialog);
  document.body.append(backdrop);

  let modal: ModalHandle | undefined;
  const close = () => {
    modal?.dispose();
    backdrop.remove();
  };
  remove.addEventListener("click", () => {
    close();
    onConfirm();
  });
  cancel.addEventListener("click", close);
  modal = activateModal(backdrop, cancel, close);
}

function actionButton(
  label: string,
  action: UpdateCommentRequest["action"],
  commentId: string,
  send: (request: UpdateCommentRequest) => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    const apply = () => {
      const requestId = `comment-${nextRequestId++}`;
      button.disabled = true;
      pendingActions.set(requestId, { button, action });
      send({ requestId, commentId, action });
    };
    if (action === "delete") {
      confirmDelete(apply);
    } else {
      apply();
    }
  });
  return button;
}

export function decorateComments(
  root: HTMLElement,
  comments: CommentPayload[],
  send: (request: UpdateCommentRequest) => void,
): void {
  removeExisting(root);
  const focusEditId = pendingFocusEditId;
  pendingFocusEditId = undefined;
  const grouped = new Map<string, CommentPayload[]>();
  for (const comment of comments) {
    if (!comment.editId) {
      continue;
    }
    const group = grouped.get(comment.editId) ?? [];
    group.push(comment);
    grouped.set(comment.editId, group);
  }

  const unanchored = comments.filter((comment) => !comment.editId);
  if (unanchored.length > 0) {
    const tray = document.createElement("aside");
    tray.className = "markdown-comment-tray";
    const heading = document.createElement("strong");
    heading.textContent = "Comments needing attention";
    tray.append(heading);
    for (const comment of unanchored) {
      const card = commentCard(comment, send);
      tray.append(card);
    }
    root.prepend(tray);
  }

  for (const [editId, group] of grouped) {
    const block = root.querySelector<HTMLElement>(
      `[data-edit-id="${CSS.escape(editId)}"]`,
    );
    if (!block) {
      continue;
    }
    const openCount = group.filter(
      (comment) => comment.resolution === "open",
    ).length;
    block.classList.add("has-markdown-comments");
    block.dataset.openCommentCount = String(openCount);
    const highlights = highlightQuotes(block, group);
    for (let index = 0; index < highlights.length; index += 1) {
      const highlight = highlights[index];
      highlight.marks.forEach((mark, markIndex) => {
        const marker = document.createElement("aside");
        marker.id = `markdown-comment-popover-${editId}-${index}-${markIndex}`;
        marker.className = "markdown-comment-marker";
        marker.dataset.commentCount = String(highlight.comments.length);
        marker.dataset.editId = editId;
        marker.setAttribute(
          "aria-label",
          `${highlight.comments.length} comment${highlight.comments.length === 1 ? "" : "s"}`,
        );
        for (const comment of highlight.comments) {
          marker.append(commentCard(comment, send));
        }
        mark.tabIndex = markIndex === 0 ? 0 : -1;
        mark.setAttribute("role", "button");
        mark.setAttribute("aria-label", marker.getAttribute("aria-label")!);
        mark.append(marker);
      });
    }
  }
  if (focusEditId) {
    const block = root.querySelector<HTMLElement>(
      `[data-edit-id="${CSS.escape(focusEditId)}"]`,
    );
    if (block) {
      block.tabIndex = -1;
      window.setTimeout(() => block.focus(), 0);
    }
  }
}

function commentCard(
  comment: CommentPayload,
  send: (request: UpdateCommentRequest) => void,
): HTMLElement {
  const card = document.createElement("article");
  card.className = `markdown-comment-card comment-${comment.resolution} anchor-${comment.health}`;
  const quote = document.createElement("blockquote");
  quote.textContent = comment.quote;
  const body = document.createElement("p");
  body.textContent = comment.body;
  const meta = document.createElement("small");
  meta.textContent = `${comment.author} · ${comment.resolution} · ${comment.health}`;
  const controls = document.createElement("div");
  controls.className = "markdown-comment-controls";
  controls.append(
    actionButton(
      comment.resolution === "open" ? "Resolve" : "Reopen",
      comment.resolution === "open" ? "resolve" : "reopen",
      comment.id,
      send,
    ),
    actionButton("Delete", "delete", comment.id, send),
  );
  card.append(quote, body, meta, controls);
  return card;
}

function closeComposer(): void {
  composerModal?.dispose();
  composerModal = undefined;
  activeComposer?.remove();
  activeComposer = undefined;
}

export function showSelectionCommentButton(
  root: HTMLElement,
  send: (request: AddCommentRequest) => void,
): void {
  selectionButton?.remove();
  selectionButton = undefined;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
    return;
  }
  const range = selection.getRangeAt(0);
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer instanceof Element
      ? range.endContainer
      : range.endContainer.parentElement;
  const startBlock = startElement?.closest<HTMLElement>("[data-edit-id]");
  const endBlock = endElement?.closest<HTMLElement>("[data-edit-id]");
  if (!startBlock || startBlock !== endBlock || !root.contains(startBlock)) {
    return;
  }
  const rect = range.getBoundingClientRect();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "markdown-add-comment-button";
  button.textContent = "Comment";
  button.setAttribute("aria-label", "Add a comment to the selected text");
  button.style.left = `${Math.max(8, rect.left)}px`;
  button.style.top = `${Math.max(8, rect.bottom + 6)}px`;
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    beginCommentFromSelection(root, send);
    button.remove();
    selectionButton = undefined;
  });
  document.body.append(button);
  selectionButton = button;
  window.addEventListener(
    "scroll",
    () => {
      if (selectionButton === button) {
        selectionButton = undefined;
      }
      button.remove();
    },
    { once: true, passive: true },
  );
}

function quoteOccurrenceBeforeRange(
  block: HTMLElement,
  range: Range,
  quote: string,
): number {
  const before = document.createRange();
  before.selectNodeContents(block);
  try {
    before.setEnd(range.startContainer, range.startOffset);
  } catch {
    return 0;
  }

  const text = before.toString();
  let occurrence = 0;
  let offset = 0;
  while (offset <= text.length - quote.length) {
    const found = text.indexOf(quote, offset);
    if (found < 0) {
      break;
    }
    occurrence += 1;
    offset = found + quote.length;
  }
  return occurrence;
}

export function beginCommentFromSelection(
  root: HTMLElement,
  send: (request: AddCommentRequest) => void,
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
    return false;
  }
  const range = selection.getRangeAt(0);
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer instanceof Element
      ? range.endContainer
      : range.endContainer.parentElement;
  const startBlock = startElement?.closest<HTMLElement>("[data-edit-id]");
  const endBlock = endElement?.closest<HTMLElement>("[data-edit-id]");
  const quote = selection.toString().trim();
  if (
    !startBlock ||
    startBlock !== endBlock ||
    !quote ||
    !root.contains(startBlock)
  ) {
    return false;
  }
  const editId = startBlock.dataset.editId;
  if (!editId) {
    return false;
  }
  const quoteOccurrence = quoteOccurrenceBeforeRange(startBlock, range, quote);
  const renderedText = textSnapshot(startBlock).text;
  let quoteCount = 0;
  let quoteOffset = 0;
  while (quoteOffset <= renderedText.length - quote.length) {
    const found = renderedText.indexOf(quote, quoteOffset);
    if (found < 0) {
      break;
    }
    quoteCount += 1;
    quoteOffset = found + quote.length;
  }

  closeComposer();
  const backdrop = document.createElement("div");
  backdrop.className = "markdown-comment-backdrop";
  const dialog = document.createElement("section");
  dialog.className = "markdown-comment-composer";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Add comment to selected Markdown text");
  const title = document.createElement("strong");
  title.textContent = "Add comment";
  const selected = document.createElement("blockquote");
  selected.textContent = quote;
  const body = document.createElement("textarea");
  body.setAttribute("aria-label", "Comment text");
  const status = document.createElement("span");
  status.className = "markdown-comment-status";
  const controls = document.createElement("div");
  controls.className = "markdown-comment-controls";
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Add";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  add.addEventListener("click", () => {
    if (!body.value.trim()) {
      status.textContent = "Enter a comment.";
      return;
    }
    const requestId = `comment-${nextRequestId++}`;
    add.disabled = true;
    body.disabled = true;
    status.textContent = "Saving…";
    pending.set(requestId, {
      requestId,
      dialog: backdrop,
      body,
      add,
      status,
    });
    send({
      requestId,
      editId,
      quote,
      quoteOccurrence,
      quoteCount,
      body: body.value.trim(),
    });
  });
  cancel.addEventListener("click", closeComposer);
  body.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      add.click();
    }
  });
  controls.append(add, cancel, status);
  dialog.append(title, selected, body, controls);
  backdrop.append(dialog);
  document.body.append(backdrop);
  activeComposer = backdrop;
  composerModal = activateModal(backdrop, body, closeComposer);
  selection.removeAllRanges();
  return true;
}

export function handleCommentResult(
  requestId: string,
  applied: boolean,
  message?: string,
): void {
  const pendingAction = pendingActions.get(requestId);
  if (pendingAction) {
    pendingActions.delete(requestId);
    if (!applied) {
      pendingAction.button.disabled = false;
      pendingAction.button.title = message ?? "Could not update comment.";
    } else if (pendingAction.action === "delete") {
      const popover = pendingAction.button.closest<HTMLElement>(
        ".markdown-comment-marker",
      );
      const editId = popover?.dataset.editId;
      const block = editId
        ? document.querySelector<HTMLElement>(
            `[data-edit-id="${CSS.escape(editId)}"]`,
          )
        : undefined;
      if (block) {
        pendingFocusEditId = editId;
      }
    }
    return;
  }
  const composer = pending.get(requestId);
  if (!composer) {
    return;
  }
  pending.delete(requestId);
  if (applied) {
    closeComposer();
    return;
  }
  composer.body.disabled = false;
  composer.add.disabled = false;
  composer.status.textContent = message ?? "Could not save comment.";
  composer.body.focus();
}
