import type Token from "markdown-it/lib/token.mjs";
import { createHash } from "node:crypto";

export type EditableBlockType =
  | "heading"
  | "paragraph"
  | "fence"
  | "math"
  | "table"
  | "list"
  | "blockquote";

export interface NavigationAnchor {
  id: string;
  key: string;
  startLine: number;
  endLine: number;
}

export interface EditableBlock extends NavigationAnchor {
  type: EditableBlockType;
  startOffset: number;
  endOffset: number;
  sourceHash: string;
}

export interface TaskMarker {
  id: string;
  line: number;
  markerOffset: number;
  checked: boolean;
  sourceHash: string;
}

export interface SourceIndex {
  anchors: NavigationAnchor[];
  editableBlocks: EditableBlock[];
  taskMarkers: TaskMarker[];
}

const NAVIGATION_TOKEN_TYPES = new Set([
  "blockquote_open",
  "bullet_list_open",
  "fence",
  "heading_open",
  "html_block",
  "math_block",
  "ordered_list_open",
  "paragraph_open",
  "table_open",
]);

interface LineOffsetTable {
  offsets: number[];
  lineCount: number;
}

function buildLineOffsets(source: string): LineOffsetTable {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      offsets.push(index + 1);
    }
  }

  return { offsets, lineCount: offsets.length };
}

function offsetForLine(
  table: LineOffsetTable,
  sourceLength: number,
  line: number,
): number {
  if (line <= 0) {
    return 0;
  }
  if (line >= table.lineCount) {
    return sourceLength;
  }
  return table.offsets[line];
}

function blockTypeFor(token: Token): EditableBlockType | undefined {
  if (token.type === "heading_open") {
    return "heading";
  }
  if (token.type === "paragraph_open") {
    return "paragraph";
  }
  if (token.type === "fence") {
    return "fence";
  }
  if (token.type === "math_block") {
    return "math";
  }
  if (token.type === "table_open") {
    return "table";
  }
  if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
    return "list";
  }
  if (token.type === "blockquote_open") {
    return "blockquote";
  }
  return undefined;
}

function isUnsafeContainer(tokens: Token[], tokenIndex: number): boolean {
  let level = 0;
  for (let index = tokenIndex - 1; index >= 0; index -= 1) {
    const candidate = tokens[index];
    if (candidate.nesting === -1) {
      level += 1;
      continue;
    }
    if (candidate.nesting !== 1) {
      continue;
    }
    if (level > 0) {
      level -= 1;
      continue;
    }
    if (
      ["list_item_open", "blockquote_open", "td_open", "th_open"].includes(
        candidate.type,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function hashSource(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildSourceIndex(source: string, tokens: Token[]): SourceIndex {
  const lineTable = buildLineOffsets(source);
  const anchors: NavigationAnchor[] = [];
  const editableBlocks: EditableBlock[] = [];
  const taskMarkers: TaskMarker[] = [];
  const seenRanges = new Set<string>();
  const keyOccurrences = new Map<string, number>();

  tokens.forEach((token, tokenIndex) => {
    if (!token.map || token.hidden) {
      return;
    }

    if (token.type === "list_item_open") {
      const line = token.map[0];
      const lineStart = offsetForLine(lineTable, source.length, line);
      const lineEnd = offsetForLine(lineTable, source.length, line + 1);
      const lineSource = source
        .slice(lineStart, lineEnd)
        .replace(/\r?\n$/u, "");
      const task = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)\[([ xX])\]/u.exec(
        lineSource,
      );
      if (task) {
        const markerOffset = lineStart + task[1].length;
        const markerSource = source.slice(markerOffset, markerOffset + 3);
        taskMarkers.push({
          id: `task-${taskMarkers.length}`,
          line,
          markerOffset,
          checked: task[2] !== " ",
          sourceHash: hashSource(markerSource),
        });
      }
    }

    const [startLine, endLine] = token.map;
    if (endLine <= startLine) {
      return;
    }

    const rangeKey = `${startLine}:${endLine}`;
    const blockType = blockTypeFor(token);
    if (!seenRanges.has(rangeKey) && NAVIGATION_TOKEN_TYPES.has(token.type)) {
      const startOffset = offsetForLine(lineTable, source.length, startLine);
      const endOffset = offsetForLine(lineTable, source.length, endLine);
      const keyBase = `${token.type}-${hashSource(
        source.slice(startOffset, endOffset),
      ).slice(0, 16)}`;
      const occurrence = keyOccurrences.get(keyBase) ?? 0;
      keyOccurrences.set(keyBase, occurrence + 1);
      anchors.push({
        id: `nav-${anchors.length}`,
        key: `${keyBase}-${occurrence}`,
        startLine,
        endLine,
      });
      seenRanges.add(rangeKey);
    }

    if (!blockType || isUnsafeContainer(tokens, tokenIndex)) {
      return;
    }

    const startOffset = offsetForLine(lineTable, source.length, startLine);
    const endOffset = offsetForLine(lineTable, source.length, endLine);
    const rawSource = source.slice(startOffset, endOffset);
    const sourceHash = hashSource(rawSource);
    editableBlocks.push({
      id: `edit-${editableBlocks.length}`,
      key: `edit-${blockType}-${sourceHash.slice(0, 16)}`,
      type: blockType,
      startLine,
      endLine,
      startOffset,
      endOffset,
      sourceHash,
    });
  });

  anchors.sort(
    (left, right) =>
      left.startLine - right.startLine || left.endLine - right.endLine,
  );
  editableBlocks.sort((left, right) => left.startOffset - right.startOffset);

  return { anchors, editableBlocks, taskMarkers };
}
