import * as vscode from "vscode";
import { type EditableBlock, type TaskMarker } from "../engine/sourceIndex";
import {
  normalizeBlockReplacement,
  sourceMatchesHash,
  validTaskMarker,
} from "./guards";

export interface GuardedEditRequest {
  uri: vscode.Uri;
  expectedDocumentVersion: number;
  block: EditableBlock;
  replacement: string;
}

export interface GuardedTaskRequest {
  uri: vscode.Uri;
  expectedDocumentVersion: number;
  task: TaskMarker;
  checked: boolean;
}

export type GuardedEditResult =
  | { applied: true; saved: boolean }
  | {
      applied: false;
      reason: "document-changed" | "source-changed" | "apply-failed";
    };

export class EditService {
  async replaceBlock(request: GuardedEditRequest): Promise<GuardedEditResult> {
    const document = await vscode.workspace.openTextDocument(request.uri);
    if (document.version !== request.expectedDocumentVersion) {
      return { applied: false, reason: "document-changed" };
    }

    const start = document.positionAt(request.block.startOffset);
    const end = document.positionAt(request.block.endOffset);
    const range = new vscode.Range(start, end);
    const original = document.getText(range);
    if (!sourceMatchesHash(original, request.block.sourceHash)) {
      return { applied: false, reason: "source-changed" };
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      request.uri,
      range,
      normalizeBlockReplacement(original, request.replacement),
    );
    if (!(await vscode.workspace.applyEdit(edit))) {
      return { applied: false, reason: "apply-failed" };
    }
    return { applied: true, saved: await document.save() };
  }

  async toggleTask(request: GuardedTaskRequest): Promise<GuardedEditResult> {
    const document = await vscode.workspace.openTextDocument(request.uri);
    if (document.version !== request.expectedDocumentVersion) {
      return { applied: false, reason: "document-changed" };
    }

    const start = document.positionAt(request.task.markerOffset);
    const end = document.positionAt(request.task.markerOffset + 3);
    const range = new vscode.Range(start, end);
    const marker = document.getText(range);
    if (!validTaskMarker(marker, request.task.sourceHash)) {
      return { applied: false, reason: "source-changed" };
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(request.uri, range, request.checked ? "[x]" : "[ ]");
    if (!(await vscode.workspace.applyEdit(edit))) {
      return { applied: false, reason: "apply-failed" };
    }
    return { applied: true, saved: await document.save() };
  }
}
