import { activateModal, type ModalHandle } from "./accessibility";

export interface CommentSegmentPayload {
  editId: string;
  quote: string;
  quoteOccurrence: number;
}

export interface CommentPayload {
  id: string;
  editId?: string;
  resolution: "open" | "resolved";
  health: "attached" | "ambiguous" | "orphaned";
  quote: string;
  quoteOccurrence: number;
  segments?: CommentSegmentPayload[];
  body: string;
  author: string;
}

interface SelectionAnchor {
  editId: string;
  quote: string;
  quoteOccurrence: number;
  quoteCount: number;
}

export interface AddCommentRequest extends SelectionAnchor {
  requestId: string;
  body: string;
  end?: SelectionAnchor;
  displayQuote?: string;
}

const BLOCK_SELECTOR = "[data-edit-id]:not(.markdown-comment-marker)";

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

interface HighlightEntry {
  comment: CommentPayload;
  quote: string;
  quoteOccurrence: number;
}

function highlightQuotes(
  block: HTMLElement,
  entries: HighlightEntry[],
): HighlightGroup[] {
  const { nodes, text } = textSnapshot(block);
  const ranges = entries
    .filter((entry) => entry.comment.health === "attached" && entry.quote)
    .map((entry) => {
      const start = occurrenceOffset(text, entry.quote, entry.quoteOccurrence);
      return {
        start,
        end: start + entry.quote.length,
        comments: [entry.comment],
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
  const grouped = new Map<string, HighlightEntry[]>();
  const addEntry = (editId: string, entry: HighlightEntry) => {
    const group = grouped.get(editId) ?? [];
    group.push(entry);
    grouped.set(editId, group);
  };
  for (const comment of comments) {
    if (comment.segments && comment.segments.length > 0) {
      for (const segment of comment.segments) {
        addEntry(segment.editId, {
          comment,
          quote: segment.quote,
          quoteOccurrence: segment.quoteOccurrence,
        });
      }
    } else if (comment.editId) {
      addEntry(comment.editId, {
        comment,
        quote: comment.quote,
        quoteOccurrence: comment.quoteOccurrence,
      });
    }
  }

  const unanchored = comments.filter(
    (comment) => !comment.editId && !comment.segments?.length,
  );
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
    const openCount = new Set(
      group
        .filter((entry) => entry.comment.resolution === "open")
        .map((entry) => entry.comment.id),
    ).size;
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
  if (!commentSelection(root, range)) {
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

/**
 * Converts a DOM boundary point into an offset within the block's comment text
 * (the same text the highlighter searches), ignoring popover and button text.
 */
function snapshotOffset(
  nodes: Text[],
  container: Node,
  offset: number,
): number {
  const point = document.createRange();
  point.setStart(container, offset);
  point.collapse(true);
  let total = 0;
  for (const node of nodes) {
    if (node === container) {
      return total + Math.min(offset, node.data.length);
    }
    if (point.comparePoint(node, 0) >= 0) {
      break;
    }
    total += node.data.length;
  }
  return total;
}

function anchorFor(
  editId: string,
  text: string,
  start: number,
  end: number,
): SelectionAnchor {
  const quote = text.slice(start, end);
  let quoteOccurrence = 0;
  let quoteCount = 0;
  let offset = 0;
  while (offset <= text.length - quote.length) {
    const found = text.indexOf(quote, offset);
    if (found < 0) {
      break;
    }
    if (found < start) {
      quoteOccurrence += 1;
    }
    quoteCount += 1;
    offset = found + quote.length;
  }
  return {
    editId,
    quote,
    quoteOccurrence,
    quoteCount: Math.max(1, quoteCount),
  };
}

interface CommentSelection {
  start: SelectionAnchor;
  end?: SelectionAnchor;
  displayQuote: string;
}

function commentSelection(
  root: HTMLElement,
  range: Range,
): CommentSelection | undefined {
  const parts: { editId: string; text: string; start: number; end: number }[] =
    [];
  for (const block of Array.from(
    root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
  )) {
    const editId = block.dataset.editId;
    if (!editId || !range.intersectsNode(block)) {
      continue;
    }
    const { nodes, text } = textSnapshot(block);
    let start = block.contains(range.startContainer)
      ? snapshotOffset(nodes, range.startContainer, range.startOffset)
      : 0;
    let end = block.contains(range.endContainer)
      ? snapshotOffset(nodes, range.endContainer, range.endOffset)
      : text.length;
    while (start < end && /\s/u.test(text[start])) {
      start += 1;
    }
    while (end > start && /\s/u.test(text[end - 1])) {
      end -= 1;
    }
    if (end > start) {
      parts.push({ editId, text, start, end });
    }
  }
  const first = parts[0];
  const last = parts.at(-1);
  if (!first || !last) {
    return undefined;
  }
  const displayQuote = parts
    .map((part) => part.text.slice(part.start, part.end))
    .join("\n\n");
  if (first === last) {
    return {
      start: anchorFor(first.editId, first.text, first.start, first.end),
      displayQuote,
    };
  }
  return {
    start: anchorFor(first.editId, first.text, first.start, first.end),
    end: anchorFor(last.editId, last.text, last.start, last.end),
    displayQuote,
  };
}

export function beginCommentFromSelection(
  root: HTMLElement,
  send: (request: AddCommentRequest) => void,
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
    return false;
  }
  const selected = commentSelection(root, selection.getRangeAt(0));
  if (!selected) {
    return false;
  }
  const quote = selected.displayQuote;

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
  const quoteElement = document.createElement("blockquote");
  quoteElement.textContent = quote;
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
      ...selected.start,
      body: body.value.trim(),
      ...(selected.end
        ? { end: selected.end, displayQuote: selected.displayQuote }
        : {}),
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
  dialog.append(title, quoteElement, body, controls);
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
