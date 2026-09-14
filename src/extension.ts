import * as vscode from "vscode";

import { PreviewManager } from "./preview/PreviewManager";

async function markdownDocumentFromContext(
  uri?: vscode.Uri,
): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    const document = await vscode.workspace.openTextDocument(uri);
    return document.languageId === "markdown" ? document : undefined;
  }
  const document = vscode.window.activeTextEditor?.document;
  return document?.languageId === "markdown" ? document : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const previews = new PreviewManager(context.extensionUri);
  previews.registerSerializer(context);
  context.subscriptions.push(
    previews,
    vscode.commands.registerCommand(
      "supermarkdown.openPreview",
      async (uri?: vscode.Uri) => {
        const document = await markdownDocumentFromContext(uri);
        if (!document) {
          void vscode.window.showWarningMessage(
            "Open a Markdown file to preview it with SuperMarkdown.",
          );
          return;
        }
        await previews.open(document, vscode.ViewColumn.Active);
      },
    ),
    vscode.commands.registerCommand(
      "supermarkdown.openPreviewToSide",
      async (uri?: vscode.Uri) => {
        const document = await markdownDocumentFromContext(uri);
        if (!document) {
          void vscode.window.showWarningMessage(
            "Open a Markdown file to preview it with SuperMarkdown.",
          );
          return;
        }
        await previews.open(document, vscode.ViewColumn.Beside);
      },
    ),
    vscode.commands.registerCommand("supermarkdown.refreshPreview", () =>
      previews.refresh(),
    ),
    vscode.commands.registerCommand("supermarkdown.togglePreviewLock", () =>
      previews.toggleLock(),
    ),
    vscode.commands.registerCommand(
      "supermarkdown.openCommentsSidecar",
      async (uri?: vscode.Uri) => {
        const document = await markdownDocumentFromContext(uri);
        await previews.openCommentsSidecar(document);
      },
    ),
  );
}

export function deactivate(): void {}
