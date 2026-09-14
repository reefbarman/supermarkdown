import * as vscode from "vscode";

import {
  contentHash,
  emptySidecar,
  reanchorSidecar,
  type CommentSidecar,
  type MarkdownComment,
} from "./model";
import { parseSidecar } from "./validation";

export type CommentStoreError =
  | "dirty-sidecar"
  | "malformed-sidecar"
  | "sidecar-conflict"
  | "write-failed";

export type CommentStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CommentStoreError };

interface SidecarSnapshot {
  sidecar: CommentSidecar;
  bytes?: Uint8Array;
}

export class CommentStore {
  private queue: Promise<unknown> = Promise.resolve();

  sidecarUri(sourceUri: vscode.Uri): vscode.Uri {
    const basename = sourceUri.path.split("/").pop() ?? "document.md";
    return vscode.Uri.joinPath(sourceUri, "..", `${basename}.comments.json`);
  }

  async load(
    document: vscode.TextDocument,
  ): Promise<CommentStoreResult<CommentSidecar>> {
    const snapshot = await this.readSnapshot(document);
    if (!snapshot.ok) {
      return snapshot;
    }
    const source = document.getText();
    return {
      ok: true,
      value: reanchorSidecar(
        snapshot.value.sidecar,
        source,
        (offset) => document.positionAt(offset).line,
      ),
    };
  }

  mutate(
    document: vscode.TextDocument,
    mutate: (sidecar: CommentSidecar) => CommentSidecar,
  ): Promise<CommentStoreResult<CommentSidecar>> {
    const operation = this.queue.then(() => this.mutateNow(document, mutate));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async reanchorExisting(
    document: vscode.TextDocument,
  ): Promise<CommentStoreResult<CommentSidecar> | undefined> {
    const uri = this.sidecarUri(document.uri);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }
    return this.mutate(document, (sidecar) => sidecar);
  }

  async openSidecar(
    document: vscode.TextDocument,
  ): Promise<vscode.TextDocument> {
    const uri = this.sidecarUri(document.uri);
    const snapshot = await this.readSnapshot(document);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    if (!snapshot.value.bytes) {
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(this.serialize(snapshot.value.sidecar), "utf8"),
      );
    }
    return vscode.workspace.openTextDocument(uri);
  }

  private async mutateNow(
    document: vscode.TextDocument,
    mutate: (sidecar: CommentSidecar) => CommentSidecar,
  ): Promise<CommentStoreResult<CommentSidecar>> {
    const uri = this.sidecarUri(document.uri);
    if (this.isDirtyInEditor(uri)) {
      return { ok: false, error: "dirty-sidecar" };
    }
    const snapshot = await this.readSnapshot(document);
    if (!snapshot.ok) {
      return snapshot;
    }

    const source = document.getText();
    const anchored = reanchorSidecar(
      snapshot.value.sidecar,
      source,
      (offset) => document.positionAt(offset).line,
    );
    const updated = mutate(anchored);
    updated.source.file = this.basename(document.uri);
    updated.source.contentHash = contentHash(source);
    updated.updatedAt = new Date().toISOString();

    if (snapshot.value.bytes) {
      try {
        const latest = await vscode.workspace.fs.readFile(uri);
        if (!Buffer.from(latest).equals(Buffer.from(snapshot.value.bytes))) {
          return { ok: false, error: "sidecar-conflict" };
        }
      } catch {
        return { ok: false, error: "sidecar-conflict" };
      }
    } else {
      try {
        await vscode.workspace.fs.stat(uri);
        return { ok: false, error: "sidecar-conflict" };
      } catch (error) {
        if (
          !(error instanceof vscode.FileSystemError) ||
          error.code !== "FileNotFound"
        ) {
          return { ok: false, error: "sidecar-conflict" };
        }
      }
    }

    const transactionId = `${process.pid}-${Date.now()}`;
    const tempUri = uri.with({ path: `${uri.path}.tmp-${transactionId}` });
    const backupUri = uri.with({ path: `${uri.path}.bak-${transactionId}` });
    let claimedExisting = false;
    try {
      await vscode.workspace.fs.writeFile(
        tempUri,
        Buffer.from(this.serialize(updated), "utf8"),
      );
      if (snapshot.value.bytes) {
        await vscode.workspace.fs.rename(uri, backupUri, { overwrite: false });
        claimedExisting = true;
        const claimed = await vscode.workspace.fs.readFile(backupUri);
        if (!Buffer.from(claimed).equals(Buffer.from(snapshot.value.bytes))) {
          await vscode.workspace.fs.rename(backupUri, uri, {
            overwrite: false,
          });
          claimedExisting = false;
          await vscode.workspace.fs.delete(tempUri);
          return { ok: false, error: "sidecar-conflict" };
        }
      }
      await vscode.workspace.fs.rename(tempUri, uri, { overwrite: false });
      if (claimedExisting) {
        await vscode.workspace.fs.delete(backupUri);
      }
      return { ok: true, value: updated };
    } catch {
      try {
        await vscode.workspace.fs.delete(tempUri);
      } catch {
        // Best-effort cleanup after a provider rejects atomic rename.
      }
      if (claimedExisting) {
        try {
          await vscode.workspace.fs.rename(backupUri, uri, {
            overwrite: false,
          });
        } catch {
          // A concurrent writer won the target path; retain the backup for recovery.
        }
      }
      return { ok: false, error: "sidecar-conflict" };
    }
  }

  private async readSnapshot(
    document: vscode.TextDocument,
  ): Promise<CommentStoreResult<SidecarSnapshot>> {
    const uri = this.sidecarUri(document.uri);
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return {
          ok: true,
          value: {
            sidecar: emptySidecar(
              this.basename(document.uri),
              document.getText(),
            ),
          },
        };
      }
      return { ok: false, error: "write-failed" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      return { ok: false, error: "malformed-sidecar" };
    }
    const sidecar = parseSidecar(parsed);
    if (!sidecar) {
      return { ok: false, error: "malformed-sidecar" };
    }
    return { ok: true, value: { sidecar, bytes } };
  }

  private isDirtyInEditor(uri: vscode.Uri): boolean {
    return vscode.workspace.textDocuments.some(
      (document) =>
        document.uri.toString() === uri.toString() && document.isDirty,
    );
  }

  private basename(uri: vscode.Uri): string {
    return uri.path.split("/").pop() ?? "document.md";
  }

  private serialize(sidecar: CommentSidecar): string {
    return `${JSON.stringify(sidecar, null, 2)}\n`;
  }
}

export function updateComment(
  sidecar: CommentSidecar,
  id: string,
  update: (comment: MarkdownComment) => MarkdownComment,
): CommentSidecar {
  return {
    ...sidecar,
    comments: sidecar.comments.map((comment) =>
      comment.id === id ? update(comment) : comment,
    ),
  };
}
