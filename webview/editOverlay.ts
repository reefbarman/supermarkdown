import { activateModal, type ModalHandle } from "./accessibility";

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

interface IndexedEditableBlock extends EditableBlockPayload {
  generation: number;
}

interface ActiveEdit {
  editId: string;
  generation: number;
  block: HTMLElement;
  editor: HTMLTextAreaElement;
  status: HTMLElement;
  dialog: HTMLElement;
  modal?: ModalHandle;
}

export interface EditRequest {
  generation: number;
  requestId: string;
  editId: string;
  replacement: string;
}

const blocks = new Map<string, IndexedEditableBlock>();
const requests = new Map<string, ActiveEdit>();
let active: ActiveEdit | undefined;
let nextRequestId = 0;

function resize(editor: HTMLTextAreaElement): void {
  editor.style.height = "auto";
  editor.style.height = `${Math.max(editor.scrollHeight, 160)}px`;
}

function close(edit: ActiveEdit): void {
  edit.modal?.dispose();
  edit.dialog.remove();
  edit.block.classList.remove("editing-markdown");
  if (active === edit) {
    active = undefined;
  }
}

function submit(edit: ActiveEdit, send: (request: EditRequest) => void): void {
  if (edit.editor.disabled) {
    return;
  }
  const requestId = `edit-${nextRequestId++}`;
  requests.set(requestId, edit);
  edit.editor.disabled = true;
  edit.status.textContent = "Saving…";
  send({
    generation: edit.generation,
    requestId,
    editId: edit.editId,
    replacement: edit.editor.value,
  });
}

function createDialog(
  payload: EditableBlockPayload,
  edit: ActiveEdit,
  send: (request: EditRequest) => void,
): HTMLElement {
  const backdrop = document.createElement("div");
  backdrop.className = "markdown-edit-backdrop";
  const dialog = document.createElement("section");
  dialog.className = "markdown-edit-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", `Edit ${payload.type} Markdown`);
  const title = document.createElement("strong");
  title.textContent = `Edit ${payload.type}`;
  const controls = document.createElement("div");
  controls.className = "markdown-edit-controls";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  save.addEventListener("click", () => submit(edit, send));
  cancel.addEventListener("click", () => close(edit));
  controls.append(save, cancel, edit.status);
  dialog.append(title, edit.editor, controls);
  backdrop.append(dialog);
  return backdrop;
}

export function openBlockEditor(
  block: HTMLElement,
  send: (request: EditRequest) => void,
): boolean {
  const editId = block.dataset.editId;
  const payload = editId ? blocks.get(editId) : undefined;
  if (!editId || !payload) {
    return false;
  }
  if (active) {
    active.editor.focus();
    return true;
  }

  const editor = document.createElement("textarea");
  editor.className = "markdown-edit-textarea";
  editor.value = payload.source;
  editor.setAttribute("aria-label", `Edit ${payload.type} Markdown source`);
  const status = document.createElement("span");
  status.className = "markdown-edit-status";
  status.setAttribute("role", "status");
  const edit: ActiveEdit = {
    editId,
    generation: payload.generation,
    block,
    editor,
    status,
    dialog: document.createElement("div"),
  };
  edit.dialog = createDialog(payload, edit, send);
  active = edit;
  block.classList.add("editing-markdown");
  document.body.append(edit.dialog);
  edit.modal = activateModal(edit.dialog, editor, () => close(edit));
  editor.addEventListener("input", () => resize(editor));
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit(edit, send);
    }
  });
  resize(editor);
  editor.setSelectionRange(editor.value.length, editor.value.length);
  return true;
}

export function decorateEditableBlocks(
  root: HTMLElement,
  editableBlocks: EditableBlockPayload[],
  generation: number,
  send: (request: EditRequest) => void,
): void {
  blocks.clear();
  for (const payload of editableBlocks) {
    blocks.set(payload.id, { ...payload, generation });
  }
  for (const block of Array.from(
    root.querySelectorAll<HTMLElement>("[data-edit-id]"),
  )) {
    const tableContainer =
      block instanceof HTMLTableElement
        ? block.parentElement?.closest<HTMLElement>(
            ".markdown-table-edit-container",
          )
        : undefined;
    const buttonContainer = tableContainer ?? block;
    if (buttonContainer.querySelector(":scope > .markdown-edit-button")) {
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = tableContainer
      ? "markdown-edit-button markdown-table-edit-button"
      : "markdown-edit-button";
    button.textContent = "Edit";
    button.setAttribute(
      "aria-label",
      `Edit ${block.dataset.editType ?? "block"} Markdown`,
    );
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openBlockEditor(block, send);
    });
    if (block instanceof HTMLTableElement && !tableContainer) {
      const container = document.createElement("div");
      container.className = "markdown-table-edit-container";
      block.before(container);
      container.append(button, block);
    } else {
      buttonContainer.prepend(button);
    }
  }
}

export function handleEditResult(
  requestId: string,
  applied: boolean,
  message?: string,
): void {
  const edit = requests.get(requestId);
  if (!edit) {
    return;
  }
  requests.delete(requestId);
  if (applied) {
    close(edit);
    return;
  }
  edit.editor.disabled = false;
  edit.status.textContent = message ?? "Could not apply edit.";
  edit.editor.focus();
}
