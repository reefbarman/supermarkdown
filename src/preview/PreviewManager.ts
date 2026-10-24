import * as vscode from "vscode";

import {
  CommentStore,
  updateComment,
  type CommentStoreError,
} from "../comments/CommentStore";
import { createComment, type CommentSidecar } from "../comments/model";
import {
  mapRenderedQuoteToSource,
  renderedQuoteOccurrenceForSource,
  renderedSegmentForSource,
} from "../comments/sourceMapping";
import { EditService, type GuardedEditResult } from "../edits/EditService";
import { renderMarkdown, type RenderResult } from "../engine/renderer";
import {
  classifyLink,
  rewriteLocalImageSources,
  type LocalImageReference,
} from "./links";
import {
  parseWebviewMessage,
  rejectedRequest,
  type AddCommentMessage,
  type CommentPayload,
  type CommentSegmentPayload,
  type CommentsMessage,
  type ExtensionToWebviewMessage,
  type PreviewErrorMessage,
  type PreviewSettings,
  type RenderMessage,
} from "./protocol";
import { webviewShell } from "./resources";

interface PreviewState {
  document: vscode.TextDocument;
  generation: number;
  render?: RenderResult;
  renderDocumentVersion?: number;
  pendingRender?: RenderMessage;
  pendingComments?: CommentsMessage;
  pendingError?: PreviewErrorMessage;
  pendingAnchor?: string;
  updateTimer?: NodeJS.Timeout;
  webviewReady: boolean;
  suppressEditorScrollUntil: number;
  imageWatchers: vscode.Disposable[];
}

interface SerializedPreviewState {
  uri?: string;
}

/** Services shared by every preview panel. */
interface PreviewServices {
  extensionUri: vscode.Uri;
  comments: CommentStore;
  edits: EditService;
  output: vscode.LogOutputChannel;
  openPreview(
    document: vscode.TextDocument,
    viewColumn: vscode.ViewColumn,
    fragment?: string,
  ): Promise<void>;
}

function isMarkdown(document: vscode.TextDocument): boolean {
  return document.languageId === "markdown";
}

function previewKey(uri: vscode.Uri): string {
  return uri.toString();
}

/**
 * Owns one preview panel per Markdown file. Each panel stays bound to the file
 * it was opened for; switching editors never changes what a panel renders.
 */
export class PreviewManager implements vscode.Disposable {
  private readonly previews = new Map<string, MarkdownPreview>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly services: PreviewServices;

  constructor(extensionUri: vscode.Uri) {
    const output = vscode.window.createOutputChannel("SuperMarkdown", {
      log: true,
    });
    this.services = {
      extensionUri,
      comments: new CommentStore(),
      edits: new EditService(),
      output,
      openPreview: (document, viewColumn, fragment) =>
        this.open(document, viewColumn, fragment),
    };
    const sidecarWatcher = vscode.workspace.createFileSystemWatcher(
      "**/*.md.comments.json",
    );
    this.disposables.push(
      output,
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isMarkdown(document) && document.uri.scheme !== "untitled") {
          void this.reanchorSavedComments(document);
        }
      }),
      vscode.workspace.onDidRenameFiles(
        (event) => void this.handleSourceRenames(event.files),
      ),
      sidecarWatcher,
      sidecarWatcher.onDidCreate((uri) => this.sidecarChanged(uri)),
      sidecarWatcher.onDidChange((uri) => this.sidecarChanged(uri)),
      sidecarWatcher.onDidDelete((uri) => this.sidecarChanged(uri)),
    );
  }

  registerSerializer(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer("supermarkdown.preview", {
        deserializeWebviewPanel: async (panel, serializedState) => {
          const restored = serializedState as
            | SerializedPreviewState
            | undefined;
          if (!restored?.uri) {
            panel.dispose();
            return;
          }
          let document: vscode.TextDocument;
          try {
            document = await vscode.workspace.openTextDocument(
              vscode.Uri.parse(restored.uri, true),
            );
          } catch {
            panel.dispose();
            return;
          }
          if (
            !isMarkdown(document) ||
            this.previews.has(previewKey(document.uri))
          ) {
            panel.dispose();
            return;
          }
          this.adopt(panel, document);
        },
      }),
    );
  }

  async open(
    document: vscode.TextDocument,
    viewColumn: vscode.ViewColumn,
    fragment?: string,
  ): Promise<void> {
    this.services.output.info(
      `Open requested for ${document.uri.toString()} in column ${viewColumn}.`,
    );
    let preview = this.previews.get(previewKey(document.uri));
    if (preview) {
      preview.reveal(viewColumn);
    } else {
      const panel = vscode.window.createWebviewPanel(
        "supermarkdown.preview",
        previewTitle(document),
        viewColumn,
        webviewOptions(this.services.extensionUri, document),
      );
      this.services.output.info("Webview panel created.");
      preview = this.adopt(panel, document);
    }
    if (fragment) {
      preview.navigateToFragment(fragment);
    }
  }

  async refresh(): Promise<void> {
    const active = this.activePreview();
    for (const preview of active ? [active] : this.previews.values()) {
      preview.refresh();
    }
  }

  async openCommentsSidecar(document?: vscode.TextDocument): Promise<void> {
    const target = document ?? this.activePreview()?.document;
    if (!target || !isMarkdown(target) || target.uri.scheme === "untitled") {
      void vscode.window.showWarningMessage(
        "Open a saved Markdown file to view its SuperMarkdown comments.",
      );
      return;
    }
    try {
      const sidecar = await this.services.comments.openSidecar(target);
      await vscode.window.showTextDocument(sidecar, { preview: false });
    } catch {
      void vscode.window.showErrorMessage(
        "SuperMarkdown could not open the comments sidecar. Check that its JSON schema is valid.",
      );
    }
  }

  dispose(): void {
    for (const preview of Array.from(this.previews.values())) {
      preview.dispose();
    }
    this.previews.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private adopt(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
  ): MarkdownPreview {
    const key = previewKey(document.uri);
    const preview = new MarkdownPreview(
      this.services,
      panel,
      document,
      (disposed) => {
        if (this.previews.get(key) === disposed) {
          this.previews.delete(key);
        }
      },
    );
    this.previews.set(key, preview);
    preview.refresh();
    return preview;
  }

  private activePreview(): MarkdownPreview | undefined {
    for (const preview of this.previews.values()) {
      if (preview.active) {
        return preview;
      }
    }
    return undefined;
  }

  private async reanchorSavedComments(
    document: vscode.TextDocument,
  ): Promise<void> {
    const result = await this.services.comments.reanchorExisting(document);
    if (result && !result.ok) {
      void vscode.window.showWarningMessage(commentStoreMessage(result.error));
    }
  }

  private async handleSourceRenames(
    files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
  ): Promise<void> {
    for (const file of files) {
      if (!/\.(?:md|mdown|markdown)$/iu.test(file.oldUri.path)) {
        continue;
      }
      const oldSidecar = this.services.comments.sidecarUri(file.oldUri);
      const newSidecar = this.services.comments.sidecarUri(file.newUri);
      try {
        await vscode.workspace.fs.stat(oldSidecar);
      } catch {
        continue;
      }
      try {
        await vscode.workspace.fs.rename(oldSidecar, newSidecar, {
          overwrite: false,
        });
      } catch {
        void vscode.window.showWarningMessage(
          "SuperMarkdown could not move the comments sidecar with the renamed Markdown file.",
        );
      }
    }
  }

  private sidecarChanged(uri: vscode.Uri): void {
    for (const preview of this.previews.values()) {
      preview.sidecarChanged(uri);
    }
  }
}

function previewTitle(document: vscode.TextDocument): string {
  return `Preview ${document.uri.path.split("/").pop() ?? "Markdown"}`;
}

function webviewOptions(
  extensionUri: vscode.Uri,
  document: vscode.TextDocument,
): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableFindWidget: true,
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, "dist"),
      vscode.workspace.getWorkspaceFolder(document.uri)?.uri ??
        vscode.Uri.joinPath(document.uri, ".."),
    ],
  };
}

function commentStoreMessage(error: CommentStoreError): string {
  if (error === "dirty-sidecar") {
    return "Save the open comments sidecar before changing comments in the preview.";
  }
  if (error === "malformed-sidecar") {
    return "The comments sidecar is invalid or uses a newer schema. It was not overwritten.";
  }
  if (error === "sidecar-conflict") {
    return "The comments sidecar changed externally. Review those changes and try again.";
  }
  return "SuperMarkdown could not read or write the comments sidecar.";
}

/** A single preview panel bound to one Markdown document for its lifetime. */
class MarkdownPreview implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private state: PreviewState | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  readonly document: vscode.TextDocument;

  constructor(
    private readonly services: PreviewServices,
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    private readonly onDisposed: (preview: MarkdownPreview) => void,
  ) {
    this.document = document;
    this.panel = panel;
    this.state = {
      document,
      generation: 0,
      webviewReady: false,
      suppressEditorScrollUntil: 0,
      imageWatchers: [],
    };
    panel.iconPath = {
      light: vscode.Uri.joinPath(
        services.extensionUri,
        "media",
        "supermarkdown-light.svg",
      ),
      dark: vscode.Uri.joinPath(
        services.extensionUri,
        "media",
        "supermarkdown-dark.svg",
      ),
    };
    panel.webview.options = webviewOptions(services.extensionUri, document);
    const shell = webviewShell(
      panel.webview,
      services.extensionUri,
      this.remoteImagesAllowed(),
    );
    panel.webview.html = shell;
    this.output.info(`Webview shell assigned (${shell.length} characters).`);
    this.updatePanelTitle();

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage(
        (value) => void this.handleMessage(value),
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isActiveDocument(event.document)) {
          this.scheduleRender();
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (
          !this.isActiveDocument(event.textEditor.document) ||
          !this.settings().scrollPreviewWithEditor
        ) {
          return;
        }
        if (Date.now() < (this.state?.suppressEditorScrollUntil ?? 0)) {
          return;
        }
        const line = event.visibleRanges[0]?.start.line;
        if (line !== undefined) {
          void this.panel?.webview.postMessage({
            type: "scrollToLine",
            generation: this.state?.generation ?? 0,
            line,
            source: "editor",
          });
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("supermarkdown") ||
          event.affectsConfiguration("markdown.preview") ||
          event.affectsConfiguration("editor.wordWrap") ||
          event.affectsConfiguration("editor.scrollBeyondLastLine")
        ) {
          if (event.affectsConfiguration("supermarkdown.allowRemoteImages")) {
            this.rebuildWebviewShell();
          } else {
            this.scheduleRender(0);
          }
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() =>
        this.rebuildWebviewShell(),
      ),
    );
  }

  get active(): boolean {
    return Boolean(this.panel?.active);
  }

  private get output(): vscode.LogOutputChannel {
    return this.services.output;
  }

  private get comments(): CommentStore {
    return this.services.comments;
  }

  reveal(viewColumn: vscode.ViewColumn): void {
    this.panel?.reveal(viewColumn);
  }

  refresh(): void {
    void this.render();
  }

  navigateToFragment(fragment: string): void {
    if (!this.panel || !this.state) {
      return;
    }
    this.state.pendingAnchor = fragment;
    this.flushPending(this.panel, this.state);
  }

  sidecarChanged(uri: vscode.Uri): void {
    if (
      this.state &&
      uri.toString() ===
        this.comments.sidecarUri(this.state.document.uri).toString()
    ) {
      this.scheduleRender(50);
    }
  }

  dispose(): void {
    if (!this.panel && !this.state) {
      return;
    }
    const panel = this.panel;
    this.clearTimer();
    this.clearImageWatchers();
    this.panel = undefined;
    this.state = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    panel?.dispose();
    this.onDisposed(this);
  }

  private remoteImagesAllowed(): boolean {
    return (
      vscode.workspace.isTrusted &&
      vscode.workspace
        .getConfiguration("supermarkdown")
        .get<boolean>("allowRemoteImages", false)
    );
  }

  private rebuildWebviewShell(): void {
    if (!this.panel || !this.state) {
      return;
    }
    this.state.webviewReady = false;
    this.state.pendingComments = undefined;
    this.state.pendingError = undefined;
    this.panel.webview.html = webviewShell(
      this.panel.webview,
      this.services.extensionUri,
      this.remoteImagesAllowed(),
    );
    void this.render();
  }

  private postWhenReady(
    panel: vscode.WebviewPanel,
    state: PreviewState,
    message: ExtensionToWebviewMessage,
  ): void {
    if (message.type === "render") {
      state.pendingRender = message;
    } else if (message.type === "comments") {
      state.pendingComments = message;
    } else if (message.type === "previewError") {
      state.pendingError = message;
    } else if (
      state.webviewReady &&
      this.panel === panel &&
      this.state === state
    ) {
      this.sendToWebview(panel, message);
    }
    this.flushPending(panel, state);
  }

  private flushPending(panel: vscode.WebviewPanel, state: PreviewState): void {
    if (!state.webviewReady || this.panel !== panel || this.state !== state) {
      return;
    }
    const render = state.pendingRender;
    const comments = state.pendingComments;
    const error = state.pendingError;
    state.pendingRender = undefined;
    state.pendingComments = undefined;
    state.pendingError = undefined;
    if (render) {
      this.sendToWebview(panel, render);
    }
    if (comments && (!render || comments.generation === render.generation)) {
      this.sendToWebview(panel, comments);
    }
    if (error) {
      this.sendToWebview(panel, error);
    }
    if (state.pendingAnchor && state.render) {
      const fragment = state.pendingAnchor;
      state.pendingAnchor = undefined;
      this.sendToWebview(panel, {
        type: "navigateAnchor",
        generation: state.generation,
        fragment,
      });
    }
  }

  private sendToWebview(
    panel: vscode.WebviewPanel,
    message: ExtensionToWebviewMessage,
  ): void {
    void Promise.resolve(panel.webview.postMessage(message))
      .then((posted) => {
        this.output.info(
          `${message.type} generation=${"generation" in message ? message.generation : "n/a"} posted=${posted}.`,
        );
      })
      .catch((error) => {
        this.output.error(
          `Failed to post ${message.type}: ${
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          }`,
        );
      });
  }

  private scheduleRender(delay?: number): void {
    if (!this.state) {
      return;
    }
    this.clearTimer();
    const configuredDelay = vscode.workspace
      .getConfiguration("supermarkdown")
      .get<number>("liveUpdateDelay", 250);
    this.state.updateTimer = setTimeout(
      () => void this.render(),
      delay ?? configuredDelay,
    );
  }

  private clearTimer(): void {
    if (this.state?.updateTimer) {
      clearTimeout(this.state.updateTimer);
      this.state.updateTimer = undefined;
    }
  }

  private clearImageWatchers(state = this.state): void {
    if (!state) {
      return;
    }
    for (const watcher of state.imageWatchers) {
      watcher.dispose();
    }
    state.imageWatchers = [];
  }

  private watchLocalImages(
    panel: vscode.WebviewPanel,
    state: PreviewState,
    images: LocalImageReference[],
  ): void {
    this.clearImageWatchers(state);
    for (const image of images) {
      const parent = vscode.Uri.joinPath(image.uri, "..");
      const basename = image.uri.path.split("/").pop();
      if (!basename) {
        continue;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(parent, "*"),
      );
      const changed = (changedUri: vscode.Uri) => {
        if (
          changedUri.toString() !== image.uri.toString() ||
          this.panel !== panel ||
          this.state !== state
        ) {
          return;
        }
        const src = image.webviewUri.with({
          query: `supermarkdown=${Date.now()}`,
        });
        this.sendToWebview(panel, {
          type: "imageChanged",
          generation: state.generation,
          key: image.key,
          src: src.toString(),
        });
      };
      state.imageWatchers.push(
        watcher,
        watcher.onDidCreate(changed),
        watcher.onDidChange(changed),
        watcher.onDidDelete(changed),
      );
    }
  }

  private settings(document = this.state?.document): PreviewSettings {
    const scope = document?.uri;
    const configuration = vscode.workspace.getConfiguration(
      "supermarkdown",
      scope,
    );
    const markdown = vscode.workspace.getConfiguration(
      "markdown.preview",
      scope,
    );
    const editor = vscode.workspace.getConfiguration("editor", scope);
    const explicit = <T>(key: string): T | undefined => {
      const inspected = configuration.inspect<T>(key);
      return (
        inspected?.workspaceFolderLanguageValue ??
        inspected?.workspaceLanguageValue ??
        inspected?.globalLanguageValue ??
        inspected?.workspaceFolderValue ??
        inspected?.workspaceValue ??
        inspected?.globalValue
      );
    };
    return {
      scrollEditorWithPreview:
        explicit<boolean>("scrollEditorWithPreview") ??
        markdown.get("scrollEditorWithPreview", true),
      scrollPreviewWithEditor:
        explicit<boolean>("scrollPreviewWithEditor") ??
        markdown.get("scrollPreviewWithEditor", true),
      preserveScrollOnUpdate: configuration.get("preserveScrollOnUpdate", true),
      openMarkdownLinks:
        explicit<"editor" | "preview">("openMarkdownLinks") ??
        (markdown.get<"inPreview" | "inEditor">(
          "openMarkdownLinks",
          "inPreview",
        ) === "inEditor"
          ? "editor"
          : "preview"),
      breaks: markdown.get("breaks", false),
      linkify: markdown.get("linkify", true),
      typographer: markdown.get("typographer", false),
      frontMatter: markdown.get("frontMatter", "table"),
      fontFamily: markdown.get(
        "fontFamily",
        "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, sans-serif",
      ),
      fontSize: markdown.get("fontSize", 14),
      lineHeight: markdown.get("lineHeight", 1.6),
      wordWrap: editor.get("wordWrap", "on"),
      scrollBeyondLastLine: editor.get("scrollBeyondLastLine", true),
    };
  }

  private async render(): Promise<void> {
    if (!this.panel || !this.state) {
      return;
    }
    this.clearTimer();
    const panel = this.panel;
    const state = this.state;
    const document = state.document;
    const documentVersion = document.version;
    const generation = state.generation + 1;
    const startedAt = Date.now();
    state.generation = generation;
    this.output.info(
      `Render ${generation} started for ${document.uri.toString()} at version ${documentVersion}.`,
    );
    const settings = this.settings(document);
    let rendered: RenderResult;
    try {
      rendered = await renderMarkdown(document.getText(), {
        breaks: settings.breaks,
        linkify: settings.linkify,
        typographer: settings.typographer,
        frontMatter: settings.frontMatter,
      });
    } catch (error) {
      this.output.error(
        `Render ${generation} failed after ${Date.now() - startedAt}ms: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
      if (
        this.panel === panel &&
        this.state === state &&
        document.version === documentVersion &&
        generation === state.generation
      ) {
        this.postWhenReady(panel, state, {
          type: "previewError",
          generation,
          message:
            error instanceof Error
              ? `SuperMarkdown could not render this document: ${error.message}`
              : "SuperMarkdown could not render this document.",
        });
      }
      return;
    }

    if (
      this.panel !== panel ||
      this.state !== state ||
      document.version !== documentVersion ||
      generation !== state.generation
    ) {
      return;
    }

    state.render = rendered;
    state.renderDocumentVersion = documentVersion;
    this.updatePanelTitle();
    const allowRemoteImages = this.remoteImagesAllowed();
    this.output.info(
      `Render ${generation} produced HTML in ${Date.now() - startedAt}ms; posting preview.`,
    );
    const resourceRoot =
      vscode.workspace.getWorkspaceFolder(document.uri)?.uri ??
      vscode.Uri.joinPath(document.uri, "..");
    const localImages: LocalImageReference[] = [];
    const html = rewriteLocalImageSources(
      rendered.html,
      document.uri,
      panel.webview,
      allowRemoteImages,
      resourceRoot,
      localImages,
    );
    this.watchLocalImages(panel, state, localImages);
    const payload: RenderMessage = {
      type: "render",
      uri: document.uri.toString(),
      documentVersion,
      generation,
      html,
      editableBlocks: rendered.sourceIndex.editableBlocks.map((block) => ({
        id: block.id,
        type: block.type,
        source: document.getText().slice(block.startOffset, block.endOffset),
      })),
      comments: [],
      notices: [],
      locked: true,
      settings,
    };
    state.pendingRender = payload;
    this.output.info(
      `Render ${generation} queued in ${Date.now() - startedAt}ms; ready=${state.webviewReady}.`,
    );
    this.flushPending(panel, state);
    void this.loadCommentsForRender(
      panel,
      state,
      document,
      documentVersion,
      generation,
      rendered,
    );
  }

  private async loadCommentsForRender(
    panel: vscode.WebviewPanel,
    state: PreviewState,
    document: vscode.TextDocument,
    documentVersion: number,
    generation: number,
    rendered: RenderResult,
  ): Promise<void> {
    this.output.info(`Render ${generation} loading comments in background.`);
    const loadedComments = await this.comments.load(document);
    if (
      this.panel !== panel ||
      this.state !== state ||
      document.version !== documentVersion ||
      generation !== state.generation
    ) {
      return;
    }
    const comments = loadedComments.ok
      ? this.commentPayloads(loadedComments.value, rendered)
      : [];
    const notices = loadedComments.ok
      ? []
      : [
          {
            level: "warning" as const,
            message: commentStoreMessage(loadedComments.error),
          },
        ];
    state.pendingComments = {
      type: "comments",
      generation,
      comments,
      notices,
    };
    this.flushPending(panel, state);
  }

  private async handleMessage(value: unknown): Promise<void> {
    try {
      await this.handleMessageNow(value);
    } catch (error) {
      this.output.error(
        `Failed to handle webview message: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
      const rejected = rejectedRequest(value);
      if (rejected) {
        await this.postCommentResult(
          rejected.requestId,
          false,
          "SuperMarkdown could not save this comment. See the SuperMarkdown output for details.",
        );
      }
    }
  }

  private async handleMessageNow(value: unknown): Promise<void> {
    const message = parseWebviewMessage(value);
    if (!this.state) {
      return;
    }
    if (!message) {
      const rejected = rejectedRequest(value);
      if (rejected) {
        this.output.warn(`Rejected malformed ${rejected.type} request.`);
        await this.postCommentResult(
          rejected.requestId,
          false,
          "SuperMarkdown could not read this comment request. Select the text again.",
        );
      }
      return;
    }
    if (message.type === "ready") {
      this.output.info("Webview ready; flushing pending payloads.");
      this.state.webviewReady = true;
      if (this.panel) {
        this.flushPending(this.panel, this.state);
      }
      if (!this.state.pendingRender && !this.state.render) {
        void this.render();
      }
      return;
    }
    if (message.type === "webviewError") {
      this.output.error(
        `Webview error: ${message.message}${message.stack ? `\n${message.stack}` : ""}`,
      );
      return;
    }
    if (message.generation !== this.state.generation) {
      if (message.type === "copyCode") {
        await this.panel?.webview.postMessage({
          type: "copyCodeResult",
          generation: this.state.generation,
          requestId: message.requestId,
          applied: false,
          message:
            "The preview changed before the code could be copied. Try again.",
        });
      } else if (
        message.type === "replaceBlock" ||
        message.type === "toggleTask"
      ) {
        await this.panel?.webview.postMessage({
          type: "editResult",
          generation: this.state.generation,
          requestId: message.requestId,
          applied: false,
          message:
            "The preview changed while this edit was open. Your draft was kept.",
        });
      } else if (
        message.type === "addComment" ||
        message.type === "updateComment"
      ) {
        await this.postCommentResult(
          message.requestId,
          false,
          "The preview changed while this comment action was open. Try again from the latest preview.",
        );
      }
      return;
    }

    if (message.type === "revealSource") {
      const anchor = this.state.render?.sourceIndex.anchors.find(
        (candidate) => candidate.id === message.sourceId,
      );
      if (anchor) {
        await this.revealLine(anchor.startLine, true);
      }
      return;
    }
    if (message.type === "previewScrolled") {
      if (this.settings().scrollEditorWithPreview) {
        await this.revealLine(Math.floor(message.line), false);
      }
      return;
    }
    if (message.type === "copyCode") {
      let applied = true;
      let response: string | undefined;
      try {
        await vscode.env.clipboard.writeText(message.code);
      } catch {
        applied = false;
        response = "SuperMarkdown could not write to the clipboard.";
      }
      await this.panel?.webview.postMessage({
        type: "copyCodeResult",
        generation: this.state.generation,
        requestId: message.requestId,
        applied,
        message: response,
      });
      return;
    }
    if (message.type === "replaceBlock") {
      const block = this.state.render?.sourceIndex.editableBlocks.find(
        (candidate) => candidate.id === message.editId,
      );
      const result = block
        ? await this.services.edits.replaceBlock({
            uri: this.state.document.uri,
            expectedDocumentVersion:
              this.state.renderDocumentVersion ?? this.state.document.version,
            block,
            replacement: message.replacement,
          })
        : ({ applied: false, reason: "source-changed" } as const);
      await this.postEditResult(message.requestId, result);
      return;
    }
    if (message.type === "toggleTask") {
      const task = this.state.render?.sourceIndex.taskMarkers.find(
        (candidate) => candidate.id === message.taskId,
      );
      const result = task
        ? await this.services.edits.toggleTask({
            uri: this.state.document.uri,
            expectedDocumentVersion:
              this.state.renderDocumentVersion ?? this.state.document.version,
            task,
            checked: message.checked,
          })
        : ({ applied: false, reason: "source-changed" } as const);
      await this.postEditResult(message.requestId, result);
      return;
    }
    if (message.type === "addComment") {
      await this.addComment(message);
      return;
    }
    if (message.type === "updateComment") {
      await this.updateCommentAction(
        message.requestId,
        message.commentId,
        message.action,
      );
      return;
    }
    await this.openLink(message.href);
  }

  private commentPayloads(
    sidecar: CommentSidecar | undefined,
    rendered: RenderResult,
  ): CommentPayload[] {
    const source = this.state?.document.getText() ?? "";
    const blocks = rendered.sourceIndex.editableBlocks;
    return (sidecar?.comments ?? []).map((comment) => {
      const attached = comment.anchor.health === "attached";
      const { start, end } = comment.anchor;
      const block = attached
        ? blocks.find(
            (candidate) =>
              start >= candidate.startOffset && end <= candidate.endOffset,
          )
        : undefined;
      const displayQuote = comment.displayQuote ?? comment.anchor.quote.exact;
      let segments: CommentSegmentPayload[] | undefined;
      if (attached && !block) {
        segments = blocks
          .filter(
            (candidate) =>
              candidate.startOffset < end && candidate.endOffset > start,
          )
          .flatMap((candidate) => {
            const segment = renderedSegmentForSource(
              source.slice(candidate.startOffset, candidate.endOffset),
              Math.max(start, candidate.startOffset) - candidate.startOffset,
              Math.min(end, candidate.endOffset) - candidate.startOffset,
            );
            return segment
              ? [
                  {
                    editId: candidate.id,
                    quote: segment.quote,
                    quoteOccurrence: segment.occurrence,
                  },
                ]
              : [];
          });
      }
      const blockSource = block
        ? source.slice(block.startOffset, block.endOffset)
        : undefined;
      const quoteOccurrence =
        block && blockSource
          ? (renderedQuoteOccurrenceForSource(
              blockSource,
              displayQuote,
              start - block.startOffset,
              end - block.startOffset,
            ) ?? 0)
          : 0;
      return {
        id: comment.id,
        editId: block?.id ?? segments?.[0]?.editId,
        resolution: comment.resolution,
        health: comment.anchor.health,
        quote: displayQuote,
        quoteOccurrence,
        ...(segments && segments.length > 0 ? { segments } : {}),
        body: comment.body,
        author: comment.author,
      };
    });
  }

  private async addComment(message: AddCommentMessage): Promise<void> {
    const { requestId } = message;
    if (!this.panel || !this.state || !this.state.render) {
      await this.postCommentResult(
        requestId,
        false,
        "The preview is still loading. Try again in a moment.",
      );
      return;
    }
    const document = this.state.document;
    if (document.uri.scheme === "untitled" || document.isDirty) {
      await this.postCommentResult(
        requestId,
        false,
        "Save the Markdown file before adding comments.",
      );
      return;
    }
    const blocks = this.state.render.sourceIndex.editableBlocks;
    const startBlock = blocks.find(
      (candidate) => candidate.id === message.editId,
    );
    const endBlock = message.end
      ? blocks.find((candidate) => candidate.id === message.end?.editId)
      : startBlock;
    if (
      !startBlock ||
      !endBlock ||
      endBlock.startOffset < startBlock.startOffset
    ) {
      await this.postCommentResult(
        requestId,
        false,
        "The selected block is no longer available. Select the text again.",
      );
      return;
    }
    const source = document.getText();
    const startMapping = mapRenderedQuoteToSource(
      source.slice(startBlock.startOffset, startBlock.endOffset),
      message.quote,
      message.quoteOccurrence,
      message.quoteCount,
    );
    const endMapping = message.end
      ? mapRenderedQuoteToSource(
          source.slice(endBlock.startOffset, endBlock.endOffset),
          message.end.quote,
          message.end.quoteOccurrence,
          message.end.quoteCount,
        )
      : startMapping;
    if (!startMapping || !endMapping) {
      await this.postCommentResult(
        requestId,
        false,
        "The selected text cannot be mapped safely through this block's Markdown formatting.",
      );
      return;
    }
    const start = startBlock.startOffset + startMapping.start;
    const end = endBlock.startOffset + endMapping.end;
    if (end <= start) {
      await this.postCommentResult(
        requestId,
        false,
        "The selected text cannot be mapped safely through this block's Markdown formatting.",
      );
      return;
    }
    const comment = createComment({
      source,
      sourceFile: document.uri.path.split("/").pop() ?? "document.md",
      start,
      end,
      lineHint: document.positionAt(start).line,
      blockStart: startBlock.startOffset,
      blockEnd: endBlock.endOffset,
      body: message.body.trim(),
      author: vscode.workspace
        .getConfiguration("supermarkdown")
        .get<string>("commentAuthor", "Tristan"),
      displayQuote: message.displayQuote ?? message.quote,
    });
    const result = await this.comments.mutate(document, (sidecar) => ({
      ...sidecar,
      comments: [...sidecar.comments, comment],
    }));
    await this.postCommentResult(
      requestId,
      result.ok,
      result.ok ? undefined : commentStoreMessage(result.error),
    );
    if (result.ok) {
      await this.render();
    }
  }

  private async updateCommentAction(
    requestId: string,
    commentId: string,
    action: "resolve" | "reopen" | "delete",
  ): Promise<void> {
    if (!this.state) {
      return;
    }
    if (
      this.state.document.uri.scheme === "untitled" ||
      this.state.document.isDirty
    ) {
      await this.postCommentResult(
        requestId,
        false,
        "Save the Markdown file before changing comments.",
      );
      return;
    }
    const result = await this.comments.mutate(
      this.state.document,
      (sidecar) => {
        if (action === "delete") {
          return {
            ...sidecar,
            comments: sidecar.comments.filter(
              (comment) => comment.id !== commentId,
            ),
          };
        }
        return updateComment(sidecar, commentId, (comment) => ({
          ...comment,
          resolution: action === "resolve" ? "resolved" : "open",
          updatedAt: new Date().toISOString(),
        }));
      },
    );
    await this.postCommentResult(
      requestId,
      result.ok,
      result.ok ? undefined : commentStoreMessage(result.error),
    );
    if (result.ok) {
      await this.render();
    }
  }

  private async postCommentResult(
    requestId: string,
    applied: boolean,
    message?: string,
  ): Promise<void> {
    await this.panel?.webview.postMessage({
      type: "commentResult",
      generation: this.state?.generation ?? 0,
      requestId,
      applied,
      message,
    });
    if (!applied && message) {
      void vscode.window.showWarningMessage(message);
    }
  }

  private async postEditResult(
    requestId: string,
    result: GuardedEditResult,
  ): Promise<void> {
    if (!this.panel || !this.state) {
      return;
    }
    const message = result.applied
      ? result.saved
        ? undefined
        : "The edit was applied, but VS Code could not save the Markdown file."
      : result.reason === "document-changed"
        ? "The source changed while this edit was open. Your draft was kept."
        : result.reason === "source-changed"
          ? "This block no longer matches the rendered preview. Your draft was kept."
          : "VS Code could not apply this edit. Your draft was kept.";
    await this.panel.webview.postMessage({
      type: "editResult",
      generation: this.state.generation,
      requestId,
      applied: result.applied,
      message,
    });
    if (result.applied) {
      this.scheduleRender(0);
      if (!result.saved) {
        void vscode.window.showWarningMessage(
          message ??
            "The edit was applied, but the Markdown file was not saved.",
        );
      }
    } else {
      void vscode.window.showWarningMessage(
        message ?? "SuperMarkdown could not apply the edit.",
      );
    }
  }

  private async openLink(href: string): Promise<void> {
    if (!this.state || !this.panel) {
      return;
    }
    const action = classifyLink(this.state.document.uri, href);
    if (action.type === "anchor") {
      await this.panel.webview.postMessage({
        type: "navigateAnchor",
        generation: this.state.generation,
        fragment: action.fragment,
      });
      return;
    }
    if (action.type === "external") {
      await vscode.env.openExternal(action.uri);
      return;
    }
    if (action.type !== "file") {
      return;
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(action.uri);
    } catch {
      void vscode.window.showWarningMessage(
        `SuperMarkdown could not open ${action.uri.fsPath || action.uri.path}.`,
      );
      return;
    }

    if (
      action.markdown &&
      isMarkdown(document) &&
      this.settings().openMarkdownLinks === "preview"
    ) {
      // Each Markdown file gets its own preview panel, opened alongside this one.
      await this.services.openPreview(
        document,
        this.panel.viewColumn ?? vscode.ViewColumn.Active,
        action.fragment,
      );
      return;
    }

    const editor = await vscode.window.showTextDocument(document, {
      preserveFocus: false,
      preview: true,
    });
    if (action.fragment) {
      const line = this.headingLine(document, action.fragment);
      if (line !== undefined) {
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      }
    }
  }

  private async revealLine(line: number, focus: boolean): Promise<void> {
    if (!this.state) {
      return;
    }
    const visibleEditor = this.findEditor(this.state.document);
    if (!focus && !visibleEditor) {
      return;
    }
    const editor =
      visibleEditor ??
      (await vscode.window.showTextDocument(this.state.document, {
        preserveFocus: false,
        preview: false,
      }));
    const safeLine = Math.max(
      0,
      Math.min(Math.floor(line), this.state.document.lineCount - 1),
    );
    const position = new vscode.Position(safeLine, 0);
    if (focus) {
      editor.selection = new vscode.Selection(position, position);
    }
    this.state.suppressEditorScrollUntil = Date.now() + 150;
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.AtTop,
    );
  }

  private findEditor(
    document: vscode.TextDocument,
  ): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === document.uri.toString(),
    );
  }

  private isActiveDocument(document: vscode.TextDocument): boolean {
    return Boolean(
      this.state &&
      document.uri.toString() === this.state.document.uri.toString(),
    );
  }

  private headingLine(
    document: vscode.TextDocument,
    fragment: string,
  ): number | undefined {
    const normalized = decodeURIComponent(fragment).toLowerCase();
    for (let line = 0; line < document.lineCount; line += 1) {
      const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(
        document.lineAt(line).text,
      );
      if (
        match &&
        match[1]
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s-]/gu, "")
          .replace(/\s+/gu, "-") === normalized
      ) {
        return line;
      }
    }
    return undefined;
  }

  private updatePanelTitle(): void {
    if (this.panel && this.state) {
      this.panel.title = previewTitle(this.state.document);
    }
  }
}
