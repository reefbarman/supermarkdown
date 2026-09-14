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
  type CommentPayload,
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
  updateTimer?: NodeJS.Timeout;
  webviewReady: boolean;
  locked: boolean;
  suppressEditorScrollUntil: number;
  imageWatchers: vscode.Disposable[];
}

interface SerializedPreviewState {
  uri?: string;
  locked?: boolean;
}

function isMarkdown(document: vscode.TextDocument): boolean {
  return document.languageId === "markdown";
}

export class PreviewManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private state: PreviewState | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly edits = new EditService();
  private readonly comments = new CommentStore();
  private readonly output = vscode.window.createOutputChannel("SuperMarkdown", {
    log: true,
  });

  constructor(private readonly extensionUri: vscode.Uri) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isActiveDocument(event.document)) {
          this.scheduleRender();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isMarkdown(document) && document.uri.scheme !== "untitled") {
          void this.reanchorSavedComments(document);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (
          editor &&
          isMarkdown(editor.document) &&
          this.state &&
          !this.state.locked
        ) {
          this.state.document = editor.document;
          this.updateLocalResourceRoots(editor.document);
          this.scheduleRender(0);
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
      vscode.workspace.onDidRenameFiles(
        (event) => void this.handleSourceRenames(event.files),
      ),
    );
    const sidecarWatcher = vscode.workspace.createFileSystemWatcher(
      "**/*.md.comments.json",
    );
    this.disposables.push(
      this.output,
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
          if (!isMarkdown(document)) {
            panel.dispose();
            return;
          }
          this.attachPanel(panel, document, Boolean(restored.locked));
          void this.render();
        },
      }),
    );
  }

  async open(
    document: vscode.TextDocument,
    viewColumn: vscode.ViewColumn,
  ): Promise<void> {
    this.output.info(
      `Open requested for ${document.uri.toString()} in column ${viewColumn}.`,
    );
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        "supermarkdown.preview",
        `Preview ${this.titleFor(document)}`,
        viewColumn,
        this.webviewOptions(document),
      );
      this.output.info("Webview panel created.");
      this.attachPanel(panel, document, false);
    } else {
      this.panel.reveal(viewColumn);
      this.clearImageWatchers();
      this.state = {
        document,
        generation: this.state?.generation ?? 0,
        locked: this.state?.locked ?? false,
        webviewReady: this.state?.webviewReady ?? false,
        suppressEditorScrollUntil: 0,
        imageWatchers: [],
      };
      this.updateLocalResourceRoots(document);
    }
    void this.render();
  }

  async refresh(): Promise<void> {
    void this.render();
  }

  async openCommentsSidecar(document?: vscode.TextDocument): Promise<void> {
    const target = document ?? this.state?.document;
    if (!target || !isMarkdown(target) || target.uri.scheme === "untitled") {
      void vscode.window.showWarningMessage(
        "Open a saved Markdown file to view its SuperMarkdown comments.",
      );
      return;
    }
    try {
      const sidecar = await this.comments.openSidecar(target);
      await vscode.window.showTextDocument(sidecar, { preview: false });
    } catch {
      void vscode.window.showErrorMessage(
        "SuperMarkdown could not open the comments sidecar. Check that its JSON schema is valid.",
      );
    }
  }

  toggleLock(): void {
    if (!this.state) {
      return;
    }
    this.state.locked = !this.state.locked;
    this.updatePanelTitle();
    void this.render();
    void vscode.window.showInformationMessage(
      `SuperMarkdown preview ${this.state.locked ? "locked" : "unlocked"}.`,
    );
  }

  dispose(): void {
    this.clearTimer();
    this.clearImageWatchers();
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private attachPanel(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    locked: boolean,
  ): void {
    this.panel?.dispose();
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(
        this.extensionUri,
        "media",
        "supermarkdown-light.svg",
      ),
      dark: vscode.Uri.joinPath(
        this.extensionUri,
        "media",
        "supermarkdown-dark.svg",
      ),
    };
    this.state = {
      document,
      generation: 0,
      locked,
      webviewReady: false,
      suppressEditorScrollUntil: 0,
      imageWatchers: [],
    };
    panel.webview.options = this.webviewOptions(document);
    const shell = webviewShell(
      panel.webview,
      this.extensionUri,
      this.remoteImagesAllowed(),
    );
    panel.webview.html = shell;
    this.output.info(`Webview shell assigned (${shell.length} characters).`);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.clearTimer();
        this.clearImageWatchers();
        this.state = undefined;
      }
    });
    panel.webview.onDidReceiveMessage(
      (value) => void this.handleMessage(value),
    );
    this.updatePanelTitle();
  }

  private webviewOptions(
    document: vscode.TextDocument,
  ): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableFindWidget: true,
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.workspace.getWorkspaceFolder(document.uri)?.uri ??
          vscode.Uri.joinPath(document.uri, ".."),
      ],
    };
  }

  private updateLocalResourceRoots(document: vscode.TextDocument): void {
    if (this.panel) {
      this.panel.webview.options = this.webviewOptions(document);
    }
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
      this.extensionUri,
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
        state.document.uri.toString() === document.uri.toString() &&
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
      state.document.uri.toString() !== document.uri.toString() ||
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
      locked: state.locked,
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
      state.document.uri.toString() !== document.uri.toString() ||
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
            message: this.commentStoreMessage(loadedComments.error),
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
    const message = parseWebviewMessage(value);
    if (!message || !this.state) {
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
        await this.panel?.webview.postMessage({
          type: "commentResult",
          generation: this.state.generation,
          requestId: message.requestId,
          applied: false,
          message:
            "The preview changed while this comment action was open. Try again from the latest preview.",
        });
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
        ? await this.edits.replaceBlock({
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
        ? await this.edits.toggleTask({
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
      await this.addComment(
        message.requestId,
        message.editId,
        message.quote,
        message.quoteOccurrence,
        message.quoteCount,
        message.body,
      );
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
    return (sidecar?.comments ?? []).map((comment) => {
      const block =
        comment.anchor.health === "attached"
          ? rendered.sourceIndex.editableBlocks.find(
              (candidate) =>
                comment.anchor.start >= candidate.startOffset &&
                comment.anchor.end <= candidate.endOffset,
            )
          : undefined;
      const displayQuote = comment.displayQuote ?? comment.anchor.quote.exact;
      const blockSource = block
        ? this.state?.document
            .getText()
            .slice(block.startOffset, block.endOffset)
        : undefined;
      const quoteOccurrence =
        block && blockSource
          ? (renderedQuoteOccurrenceForSource(
              blockSource,
              displayQuote,
              comment.anchor.start - block.startOffset,
              comment.anchor.end - block.startOffset,
            ) ?? 0)
          : 0;
      return {
        id: comment.id,
        editId: block?.id,
        resolution: comment.resolution,
        health: comment.anchor.health,
        quote: displayQuote,
        quoteOccurrence,
        body: comment.body,
        author: comment.author,
      };
    });
  }

  private async addComment(
    requestId: string,
    editId: string,
    quote: string,
    quoteOccurrence: number,
    quoteCount: number,
    body: string,
  ): Promise<void> {
    if (!this.panel || !this.state || !this.state.render) {
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
    const block = this.state.render.sourceIndex.editableBlocks.find(
      (candidate) => candidate.id === editId,
    );
    if (!block) {
      await this.postCommentResult(
        requestId,
        false,
        "The selected block is no longer available. Select the text again.",
      );
      return;
    }
    const source = document.getText();
    const blockSource = source.slice(block.startOffset, block.endOffset);
    const mapping = mapRenderedQuoteToSource(
      blockSource,
      quote,
      quoteOccurrence,
      quoteCount,
    );
    if (!mapping) {
      await this.postCommentResult(
        requestId,
        false,
        "The selected text cannot be mapped safely through this block's Markdown formatting.",
      );
      return;
    }
    const start = block.startOffset + mapping.start;
    const end = block.startOffset + mapping.end;
    const comment = createComment({
      source,
      sourceFile: document.uri.path.split("/").pop() ?? "document.md",
      start,
      end,
      lineHint: document.positionAt(start).line,
      blockStart: block.startOffset,
      blockEnd: block.endOffset,
      body: body.trim(),
      author: vscode.workspace
        .getConfiguration("supermarkdown")
        .get<string>("commentAuthor", "Tristan"),
      displayQuote: quote,
    });
    const result = await this.comments.mutate(document, (sidecar) => ({
      ...sidecar,
      comments: [...sidecar.comments, comment],
    }));
    await this.postCommentResult(
      requestId,
      result.ok,
      result.ok ? undefined : this.commentStoreMessage(result.error),
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
      result.ok ? undefined : this.commentStoreMessage(result.error),
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

  private commentStoreMessage(error: CommentStoreError): string {
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

  private async reanchorSavedComments(
    document: vscode.TextDocument,
  ): Promise<void> {
    const result = await this.comments.reanchorExisting(document);
    if (result && !result.ok) {
      void vscode.window.showWarningMessage(
        this.commentStoreMessage(result.error),
      );
    }
  }

  private async handleSourceRenames(
    files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
  ): Promise<void> {
    for (const file of files) {
      if (!/\.(?:md|mdown|markdown)$/iu.test(file.oldUri.path)) {
        continue;
      }
      const oldSidecar = this.comments.sidecarUri(file.oldUri);
      const newSidecar = this.comments.sidecarUri(file.newUri);
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
    if (
      this.state &&
      uri.toString() ===
        this.comments.sidecarUri(this.state.document.uri).toString()
    ) {
      this.scheduleRender(50);
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

    if (action.markdown && this.settings().openMarkdownLinks === "preview") {
      this.state.document = document;
      this.state.locked = true;
      this.updateLocalResourceRoots(document);
      await this.render();
      if (action.fragment) {
        await this.panel.webview.postMessage({
          type: "navigateAnchor",
          generation: this.state.generation,
          fragment: action.fragment,
        });
      }
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
      this.panel.title = `Preview ${this.titleFor(this.state.document)}${
        this.state.locked ? " (Locked)" : ""
      }`;
    }
  }

  private titleFor(document: vscode.TextDocument): string {
    return document.uri.path.split("/").pop() ?? "Markdown";
  }
}
