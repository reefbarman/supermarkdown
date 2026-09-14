import type { EditRequest, EditableBlockPayload } from "./editOverlay";

interface IndexedTableBlock extends EditableBlockPayload {
  generation: number;
}

interface TableCellLocation {
  editId: string;
  rowIndex: number;
  columnIndex: number;
}

interface ActiveTableEdit extends TableCellLocation {
  requestId?: string;
  cell: HTMLTableCellElement;
  input: HTMLInputElement;
  originalHtml: string;
  originalText: string;
  replacement: string;
  closed: boolean;
  restoreFocus: boolean;
  restoreFocusAfterRender: boolean;
}

const tables = new Map<string, IndexedTableBlock>();
const requests = new Map<string, ActiveTableEdit>();
let active: ActiveTableEdit | undefined;
let queued: TableCellLocation | undefined;
let nextRequestId = 0;

interface ParsedRow {
  prefix: string;
  suffix: string;
  leadingPipe: boolean;
  trailingPipe: boolean;
  cells: string[];
}

function parseRow(line: string): ParsedRow | undefined {
  const prefix = /^\s*/u.exec(line)?.[0] ?? "";
  const suffix = /\s*$/u.exec(line)?.[0] ?? "";
  const core = line.slice(prefix.length, line.length - suffix.length);
  const separators: number[] = [];
  let escaped = false;

  for (let index = 0; index < core.length; index += 1) {
    const character = core[index];
    if (character === "|" && !escaped) {
      separators.push(index);
    }
    escaped = character === "\\";
  }

  if (separators.length === 0) {
    return {
      prefix,
      suffix,
      leadingPipe: false,
      trailingPipe: false,
      cells: [core],
    };
  }

  const segments: string[] = [];
  let start = 0;
  for (const separator of separators) {
    segments.push(core.slice(start, separator));
    start = separator + 1;
  }
  segments.push(core.slice(start));

  const leadingPipe = separators[0] === 0;
  const trailingPipe = separators[separators.length - 1] === core.length - 1;
  if (leadingPipe) {
    segments.shift();
  }
  if (trailingPipe) {
    segments.pop();
  }

  return { prefix, suffix, leadingPipe, trailingPipe, cells: segments };
}

function formattedCell(original: string | undefined, value: string): string {
  if (original === undefined || original.trim().length === 0) {
    return ` ${value} `;
  }
  const leading = /^\s*/u.exec(original)?.[0] ?? "";
  let trailing = /\s*$/u.exec(original)?.[0] ?? "";
  if (!trailing && value.endsWith("\\")) {
    trailing = " ";
  }
  return `${leading}${value}${trailing}`;
}

function escapedCellValue(value: string): string {
  return value
    .replace(/\r?\n/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|");
}

function replaceLine(
  source: string,
  lineIndex: number,
  replacement: string,
): string | undefined {
  let start = 0;
  for (let current = 0; current <= lineIndex; current += 1) {
    if (start > source.length) {
      return undefined;
    }
    const newline = source.indexOf("\n", start);
    const lineEnd = newline < 0 ? source.length : newline;
    const contentEnd =
      source.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    if (current === lineIndex) {
      return source.slice(0, start) + replacement + source.slice(contentEnd);
    }
    if (newline < 0) {
      return undefined;
    }
    start = newline + 1;
  }
  return undefined;
}

export function replaceMarkdownTableCell(
  source: string,
  rowIndex: number,
  columnIndex: number,
  value: string,
): string | undefined {
  if (
    !Number.isSafeInteger(rowIndex) ||
    rowIndex < 0 ||
    !Number.isSafeInteger(columnIndex) ||
    columnIndex < 0
  ) {
    return undefined;
  }

  const sourceLineIndex = rowIndex === 0 ? 0 : rowIndex + 1;
  let lineStart = 0;
  for (let current = 0; current < sourceLineIndex; current += 1) {
    const newline = source.indexOf("\n", lineStart);
    if (newline < 0) {
      return undefined;
    }
    lineStart = newline + 1;
  }
  const newline = source.indexOf("\n", lineStart);
  const lineEnd = newline < 0 ? source.length : newline;
  const contentEnd =
    source.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
  const parsed = parseRow(source.slice(lineStart, contentEnd));
  if (!parsed) {
    return undefined;
  }

  while (parsed.cells.length <= columnIndex) {
    parsed.cells.push("");
  }
  parsed.cells[columnIndex] = formattedCell(
    parsed.cells[columnIndex],
    escapedCellValue(value),
  );
  const updatedLine = `${parsed.prefix}${parsed.leadingPipe ? "|" : ""}${parsed.cells.join("|")}${parsed.trailingPipe ? "|" : ""}${parsed.suffix}`;
  return replaceLine(source, sourceLineIndex, updatedLine);
}

function close(edit: ActiveTableEdit, saved = false): void {
  const restoreFocus =
    edit.restoreFocus || document.activeElement === edit.input;
  edit.closed = true;
  if (active === edit) {
    active = undefined;
  }
  if (!edit.cell.isConnected) {
    return;
  }
  if (saved) {
    edit.cell.textContent = edit.input.value;
  } else {
    edit.cell.innerHTML = edit.originalHtml;
  }
  edit.cell.classList.remove("editing-table-cell");
  if (restoreFocus) {
    edit.cell.focus();
  }
}

function submit(
  edit: ActiveTableEdit,
  send: (request: EditRequest) => void,
): void {
  if (edit.closed || edit.input.disabled || edit.requestId) {
    return;
  }
  if (edit.input.value === edit.originalText) {
    close(edit);
    return;
  }

  const requestId = `table-${nextRequestId++}`;
  edit.requestId = requestId;
  edit.restoreFocus = document.activeElement === edit.input;
  edit.input.disabled = true;
  edit.input.setAttribute("aria-busy", "true");
  requests.set(requestId, edit);
  send({
    generation: Number(edit.input.dataset.generation),
    requestId,
    editId: edit.input.dataset.editId ?? "",
    replacement: edit.replacement,
  });
}

function locationForCell(
  cell: HTMLTableCellElement,
): TableCellLocation | undefined {
  const table = cell.closest<HTMLTableElement>("table[data-edit-id]");
  const editId = table?.dataset.editId;
  const row = cell.parentElement;
  if (!table || !editId || !(row instanceof HTMLTableRowElement)) {
    return undefined;
  }
  const rowIndex = Array.from(table.rows).indexOf(row);
  const columnIndex = Array.from(row.cells).indexOf(cell);
  return rowIndex >= 0 && columnIndex >= 0
    ? { editId, rowIndex, columnIndex }
    : undefined;
}

function cellForLocation(
  root: ParentNode,
  location: TableCellLocation,
): HTMLTableCellElement | undefined {
  const table = root.querySelector<HTMLTableElement>(
    `table[data-edit-id="${CSS.escape(location.editId)}"]`,
  );
  const row = table?.rows.item(location.rowIndex);
  return row?.cells.item(location.columnIndex) ?? undefined;
}

function openQueuedTableCell(send: (request: EditRequest) => void): void {
  if (!queued || active) {
    return;
  }
  const location = queued;
  queued = undefined;
  const cell = cellForLocation(document, location);
  if (cell) {
    openTableCellEditor(cell, send);
  }
}

export function openTableCellEditor(
  cell: HTMLTableCellElement,
  send: (request: EditRequest) => void,
): boolean {
  const location = locationForCell(cell);
  if (active && location) {
    if (
      active.editId !== location.editId ||
      active.rowIndex !== location.rowIndex ||
      active.columnIndex !== location.columnIndex
    ) {
      queued = location;
    }
    active.input.focus();
    return true;
  }
  const payload = location ? tables.get(location.editId) : undefined;
  if (
    !location ||
    !payload ||
    payload.type !== "table" ||
    cell.childElementCount > 0
  ) {
    return false;
  }

  const { editId, rowIndex, columnIndex } = location;

  const originalText = cell.textContent?.trim() ?? "";
  const replacement = replaceMarkdownTableCell(
    payload.source,
    rowIndex,
    columnIndex,
    originalText,
  );
  if (replacement === undefined) {
    return false;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "markdown-table-cell-input";
  input.value = originalText;
  input.dataset.generation = String(payload.generation);
  input.dataset.editId = editId;
  input.setAttribute(
    "aria-label",
    `Edit table cell, row ${rowIndex + 1}, column ${columnIndex + 1}`,
  );
  const edit: ActiveTableEdit = {
    editId,
    rowIndex,
    columnIndex,
    cell,
    input,
    originalHtml: cell.innerHTML,
    originalText,
    replacement,
    closed: false,
    restoreFocus: false,
    restoreFocusAfterRender: false,
  };

  const updateReplacement = () => {
    const current = tables.get(editId);
    if (current) {
      edit.replacement =
        replaceMarkdownTableCell(
          current.source,
          rowIndex,
          columnIndex,
          input.value,
        ) ?? edit.replacement;
    }
  };
  input.addEventListener("input", updateReplacement);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(edit);
    } else if (event.key === "Enter") {
      event.preventDefault();
      updateReplacement();
      submit(edit, send);
    }
  });
  input.addEventListener("blur", () => {
    updateReplacement();
    submit(edit, send);
  });

  active = edit;
  cell.classList.add("editing-table-cell");
  cell.replaceChildren(input);
  input.focus();
  input.select();
  return true;
}

export function prepareEditableTablesForRefresh(): void {
  if (active) {
    active.restoreFocusAfterRender = document.activeElement === active.input;
  }
}

export function decorateEditableTables(
  root: HTMLElement,
  editableBlocks: EditableBlockPayload[],
  generation: number,
  send: (request: EditRequest) => void,
): void {
  tables.clear();
  for (const payload of editableBlocks) {
    if (payload.type === "table") {
      tables.set(payload.id, { ...payload, generation });
    }
  }
  if (active && !active.input.isConnected) {
    const payload = tables.get(active.editId);
    const cell = cellForLocation(root, active);
    if (payload && cell && cell.childElementCount === 0) {
      active.cell = cell;
      active.originalHtml = cell.innerHTML;
      active.originalText = cell.textContent?.trim() ?? "";
      active.replacement =
        replaceMarkdownTableCell(
          payload.source,
          active.rowIndex,
          active.columnIndex,
          active.input.value,
        ) ?? active.replacement;
      active.input.dataset.generation = String(payload.generation);
      cell.classList.add("editing-table-cell");
      cell.replaceChildren(active.input);
      if (active.restoreFocusAfterRender) {
        active.input.focus();
      }
    } else {
      active.closed = true;
      active = undefined;
    }
  }
  for (const cell of Array.from(
    root.querySelectorAll<HTMLTableCellElement>(
      'table[data-edit-type="table"] > thead > tr > th, table[data-edit-type="table"] > tbody > tr > td',
    ),
  )) {
    if (cell.childElementCount > 0) {
      continue;
    }
    cell.tabIndex = 0;
    cell.classList.add("markdown-editable-table-cell");
    cell.title = "Click or press Enter to edit this cell";
  }
  openQueuedTableCell(send);
}

export function handleTableEditResult(
  requestId: string,
  applied: boolean,
  message: string | undefined,
  send: (request: EditRequest) => void,
): boolean {
  const edit = requests.get(requestId);
  if (!edit) {
    return false;
  }
  requests.delete(requestId);
  edit.requestId = undefined;
  if (edit.closed) {
    return true;
  }
  if (applied) {
    close(edit, true);
  } else {
    queued = undefined;
    edit.input.disabled = false;
    edit.input.removeAttribute("aria-busy");
    edit.input.title = message ?? "Could not update table cell.";
    if (edit.restoreFocus) {
      edit.input.focus();
    }
  }
  return true;
}
