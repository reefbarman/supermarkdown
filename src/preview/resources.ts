import * as vscode from "vscode";

export function nonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

export function webviewShell(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  allowRemoteImages = false,
): string {
  const scriptNonce = nonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js"),
  );
  const markdownCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "github-markdown.css"),
  );
  const katexCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "katex.min.css"),
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}${allowRemoteImages ? " https:" : ""}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}';">
  <link rel="stylesheet" href="${markdownCssUri}">
  <link rel="stylesheet" href="${katexCssUri}">
  <style>
    html, body { font-family: var(--markdown-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif); font-size: var(--markdown-font-size, 14px); line-height: var(--markdown-line-height, 1.6); margin: 0; padding: 0; }
    body { color: var(--vscode-editor-foreground); }
    body.modal-open { overflow: hidden; }
    :focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .sr-only { height: 1px; margin: -1px; overflow: hidden; padding: 0; position: absolute; width: 1px; clip: rect(0, 0, 0, 0); white-space: nowrap; }
    .markdown-body { --fgColor-default: #1f2328; --fgColor-muted: #59636e; --bgColor-default: var(--vscode-editor-background); box-sizing: border-box; color: var(--fgColor-default); background: var(--vscode-editor-background); min-width: 200px; margin: 0; max-width: none; padding: 45px 32px 32px; word-wrap: break-word; }
    body.markdown-scroll-beyond-last-line .markdown-body { padding-bottom: calc(100vh - 1em); }
    body.markdown-nowrap .markdown-body { overflow-wrap: normal; word-wrap: normal; }
    body.markdown-nowrap .markdown-body pre { overflow-x: auto; white-space: pre; }
    body.vscode-dark .markdown-body, body.vscode-high-contrast .markdown-body { --fgColor-default: #f0f6fc; --fgColor-muted: #9198a1; }
    .markdown-body > :first-child { margin-top: 0 !important; }
    .markdown-body [data-source-id] { scroll-margin-top: 1rem; }
    .markdown-body [data-source-id]:hover { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }

    .markdown-body [data-edit-id] { position: relative; }
    .markdown-table-edit-container { display: table; max-width: 100%; position: relative; }
    .markdown-table-edit-container > table { margin: 0; }
    .markdown-edit-button { background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; color: var(--vscode-button-secondaryForeground); cursor: pointer; font: inherit; font-size: 11px; opacity: 0; padding: 2px 6px; position: absolute; right: 0; top: 0; transform: translateY(-100%); }
    [data-edit-id]:hover > .markdown-edit-button, [data-edit-id]:focus-within > .markdown-edit-button, .markdown-table-edit-container:hover > .markdown-edit-button, .markdown-table-edit-container:focus-within > .markdown-edit-button, .markdown-edit-button:focus { opacity: 1; }
    .markdown-table-edit-button { top: 4px; transform: none; z-index: 2; }
    .editing-markdown { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .markdown-edit-backdrop { align-items: center; background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent); display: flex; inset: 0; justify-content: center; padding: 24px; position: fixed; z-index: 1000; }
    .markdown-edit-dialog { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); box-shadow: 0 8px 24px var(--vscode-widget-shadow); box-sizing: border-box; max-height: calc(100vh - 48px); max-width: 900px; overflow: auto; padding: 14px; width: min(900px, 100%); }
    .markdown-edit-textarea { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder)); box-sizing: border-box; color: var(--vscode-input-foreground); display: block; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.45; margin-top: 10px; min-height: 160px; resize: vertical; width: 100%; }
    .markdown-edit-controls { align-items: center; display: flex; gap: 8px; margin-top: 6px; }
    .markdown-edit-controls button { background: var(--vscode-button-background); border: 0; border-radius: 2px; color: var(--vscode-button-foreground); cursor: pointer; padding: 4px 10px; }
    .markdown-edit-status { color: var(--vscode-errorForeground); font-size: 12px; }
    .markdown-editable-table-cell { cursor: text; }
    .markdown-editable-table-cell:hover { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
    .markdown-editable-table-cell.editing-table-cell { box-shadow: inset 0 0 0 2px var(--vscode-focusBorder); padding: 0; }
    .markdown-table-cell-input { background: var(--vscode-input-background); border: 0; box-sizing: border-box; color: var(--vscode-input-foreground); font: inherit; min-width: 8em; outline: 0; padding: 6px 13px; width: 100%; }
    .task-list-item-checkbox:not(:disabled) { cursor: pointer; }
    .has-markdown-comments { position: relative; }
    .markdown-comment-highlight { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d7a400) 18%, transparent); border-bottom: 2px solid var(--vscode-editorWarning-foreground, #d7a400); border-radius: 1px; color: inherit; cursor: pointer; padding: 0 1px; position: relative; }
    .markdown-comment-highlight:hover, .markdown-comment-highlight:focus, .markdown-comment-highlight[aria-expanded="true"] { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d7a400) 30%, transparent); box-shadow: 0 1px 0 var(--vscode-editorWarning-foreground, #d7a400); outline: none; }
    .markdown-comment-highlight-resolved { background: color-mix(in srgb, var(--vscode-descriptionForeground) 9%, transparent); border-bottom: 1px dotted color-mix(in srgb, var(--vscode-descriptionForeground) 65%, transparent); }
    .markdown-comment-highlight-resolved:hover, .markdown-comment-highlight-resolved:focus, .markdown-comment-highlight-resolved:focus-within { background: color-mix(in srgb, var(--vscode-descriptionForeground) 18%, transparent); border-bottom-color: var(--vscode-descriptionForeground); box-shadow: 0 1px 0 color-mix(in srgb, var(--vscode-descriptionForeground) 55%, transparent); }
    .markdown-comment-marker { background: var(--vscode-editorHoverWidget-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, var(--vscode-focusBorder))); border-radius: 4px; box-shadow: 0 4px 14px var(--vscode-widget-shadow); box-sizing: border-box; color: var(--vscode-editorHoverWidget-foreground, var(--vscode-editor-foreground)); display: none; left: 0; max-height: min(420px, calc(100vh - 16px)); min-width: min(380px, calc(100vw - 32px)); overflow: auto; padding: 10px; position: absolute; text-align: left; top: calc(100% + 6px); white-space: normal; z-index: 900; }
    .markdown-comment-highlight:hover > .markdown-comment-marker, .markdown-comment-highlight:focus-within > .markdown-comment-marker { display: block; }
    .markdown-comment-card + .markdown-comment-card { border-top: 1px solid var(--vscode-widget-border); margin-top: 8px; padding-top: 8px; }
    .markdown-comment-card blockquote { font-size: 12px; margin: 0 0 6px; opacity: .8; padding: 0 8px; }
    .markdown-comment-card p { margin: 4px 0; }
    .markdown-comment-card small { opacity: .7; }
    .comment-resolved { opacity: .65; }
    .anchor-ambiguous, .anchor-orphaned { border-left: 3px solid var(--vscode-editorWarning-foreground); padding-left: 8px; }
    .markdown-comment-tray { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-editorWarning-foreground); margin-bottom: 16px; padding: 10px; }
    .markdown-comment-controls { align-items: center; display: flex; gap: 8px; margin-top: 6px; }
    .markdown-comment-controls button, .markdown-add-comment-button { background: var(--vscode-button-background); border: 0; border-radius: 2px; color: var(--vscode-button-foreground); cursor: pointer; padding: 4px 10px; }
    .markdown-add-comment-button { position: fixed; z-index: 1100; }
    .markdown-comment-backdrop { align-items: center; background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent); display: flex; inset: 0; justify-content: center; padding: 24px; position: fixed; z-index: 1200; }
    .markdown-comment-composer { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); box-shadow: 0 8px 24px var(--vscode-widget-shadow); box-sizing: border-box; max-width: 680px; padding: 14px; width: min(680px, 100%); }
    .markdown-comment-composer blockquote { margin: 10px 0; max-height: 120px; overflow: auto; }
    .markdown-comment-composer textarea { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder)); box-sizing: border-box; color: var(--vscode-input-foreground); min-height: 120px; resize: vertical; width: 100%; }
    .markdown-comment-status { color: var(--vscode-errorForeground); font-size: 12px; }
    .preview-notices { margin-bottom: 16px; }
    .preview-notice { border-left: 4px solid var(--vscode-editorInfo-foreground); margin: 6px 0; padding: 8px 12px; }
    .preview-notice-warning { border-left-color: var(--vscode-editorWarning-foreground); }
    .preview-notice-error { border-left-color: var(--vscode-editorError-foreground); color: var(--vscode-errorForeground); }
    .image-load-error { border: 1px dashed var(--vscode-editorWarning-foreground); color: var(--vscode-descriptionForeground); display: inline-block; padding: 4px 8px; }
    .markdown-code-block { position: relative; }
    .markdown-copy-button { background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; color: var(--vscode-button-secondaryForeground); cursor: pointer; font: inherit; font-size: 11px; opacity: 0; padding: 2px 7px; position: absolute; right: 6px; top: 6px; }
    .markdown-code-block:hover > .markdown-copy-button, .markdown-copy-button:focus { opacity: 1; }
    .markdown-body .hljs-keyword, .markdown-body .hljs-literal, .markdown-body .hljs-symbol, .markdown-body .hljs-name, .markdown-body .hljs-link { color: #569cd6; }
    .markdown-body .hljs-link { text-decoration: underline; }
    .markdown-body .hljs-built_in, .markdown-body .hljs-type { color: #4ec9b0; }
    .markdown-body .hljs-number, .markdown-body .hljs-class { color: #b8d7a3; }
    .markdown-body .hljs-string, .markdown-body .hljs-meta-string { color: #d69d85; }
    .markdown-body .hljs-regexp, .markdown-body .hljs-template-tag { color: #9a5334; }
    .markdown-body .hljs-subst, .markdown-body .hljs-function, .markdown-body .hljs-title, .markdown-body .hljs-params, .markdown-body .hljs-formula { color: #dcdcdc; }
    .markdown-body .hljs-comment, .markdown-body .hljs-quote { color: #57a64a; font-style: italic; }
    .markdown-body .hljs-doctag { color: #608b4e; }
    .markdown-body .hljs-meta, .markdown-body .hljs-meta-keyword, .markdown-body .hljs-tag { color: #9b9b9b; }
    .markdown-body .hljs-variable, .markdown-body .hljs-template-variable { color: #bd63c5; }
    .markdown-body .hljs-attr, .markdown-body .hljs-attribute, .markdown-body .hljs-builtin-name { color: #9cdcfe; }
    .markdown-body .hljs-section { color: gold; }
    .markdown-body .hljs-emphasis { font-style: italic; }
    .markdown-body .hljs-strong { font-weight: bold; }
    .markdown-body .hljs-bullet, .markdown-body .hljs-selector-tag, .markdown-body .hljs-selector-id, .markdown-body .hljs-selector-class, .markdown-body .hljs-selector-attr, .markdown-body .hljs-selector-pseudo { color: #d7ba7d; }
    .markdown-body .hljs-addition { background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, .2)); color: rgb(155, 185, 85); display: inline-block; width: 100%; }
    .markdown-body .hljs-deletion { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, .2)); color: rgb(255, 0, 0); display: inline-block; width: 100%; }
    body.vscode-light .markdown-body .hljs-function, body.vscode-light .markdown-body .hljs-params, body.vscode-light .markdown-body .hljs-number, body.vscode-light .markdown-body .hljs-class { color: inherit; }
    body.vscode-light .markdown-body .hljs-comment, body.vscode-light .markdown-body .hljs-quote, body.vscode-light .markdown-body .hljs-number, body.vscode-light .markdown-body .hljs-class, body.vscode-light .markdown-body .hljs-variable { color: #008000; }
    body.vscode-light .markdown-body .hljs-keyword, body.vscode-light .markdown-body .hljs-selector-tag, body.vscode-light .markdown-body .hljs-name, body.vscode-light .markdown-body .hljs-tag { color: #00f; }
    body.vscode-light .markdown-body .hljs-built_in, body.vscode-light .markdown-body .hljs-builtin-name { color: #007acc; }
    body.vscode-light .markdown-body .hljs-string, body.vscode-light .markdown-body .hljs-section, body.vscode-light .markdown-body .hljs-attribute, body.vscode-light .markdown-body .hljs-literal, body.vscode-light .markdown-body .hljs-template-tag, body.vscode-light .markdown-body .hljs-template-variable, body.vscode-light .markdown-body .hljs-type { color: #a31515; }
    body.vscode-light .markdown-body .hljs-subst, body.vscode-light .markdown-body .hljs-selector-attr, body.vscode-light .markdown-body .hljs-selector-pseudo, body.vscode-light .markdown-body .hljs-meta, body.vscode-light .markdown-body .hljs-meta-keyword { color: #2b91af; }
    body.vscode-light .markdown-body .hljs-title, body.vscode-light .markdown-body .hljs-doctag { color: #808080; }
    body.vscode-light .markdown-body .hljs-attr { color: #f00; }
    body.vscode-light .markdown-body .hljs-symbol, body.vscode-light .markdown-body .hljs-bullet, body.vscode-light .markdown-body .hljs-link { color: #00b0e8; }
    .markdown-alert { border-left: .25em solid var(--vscode-textBlockQuote-border); padding: .5rem 1rem; }
    .markdown-alert-title { align-items: center; display: flex; font-weight: 600; gap: .4em; margin: 0 0 .5rem; }
    .markdown-alert-title::before { content: "ⓘ"; font-size: 1.05em; line-height: 1; }
    .markdown-alert-tip .markdown-alert-title::before { content: "✦"; }
    .markdown-alert-important .markdown-alert-title::before { content: "◆"; }
    .markdown-alert-warning .markdown-alert-title::before { content: "⚠"; }
    .markdown-alert-caution .markdown-alert-title::before { content: "⛔"; }
    .markdown-alert-note { border-left-color: var(--vscode-textLink-foreground); }
    .markdown-alert-warning, .markdown-alert-caution { border-left-color: var(--vscode-editorWarning-foreground); }
    .markdown-alert-tip, .markdown-alert-important { border-left-color: var(--vscode-testing-iconPassed); }
    .mermaid-diagram { margin: 1rem 0; text-align: center; }
    .mermaid-output svg { color: var(--fgColor-default); max-width: 100%; height: auto; }
    .mermaid-output text, .mermaid-output .nodeLabel, .mermaid-output .label { color: var(--fgColor-default) !important; fill: var(--fgColor-default) !important; }
    .mermaid-output .node rect, .mermaid-output .node polygon, .mermaid-output .node path { fill: var(--vscode-editor-background) !important; stroke: var(--vscode-descriptionForeground) !important; }
    .mermaid-source { text-align: left; }
    .mermaid-error-message { color: var(--vscode-errorForeground); font-weight: 600; margin-bottom: 6px; text-align: left; }
    .mermaid-error-details { color: var(--vscode-errorForeground); font-size: 12px; max-height: 220px; overflow: auto; text-align: left; white-space: pre-wrap; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
    @media (forced-colors: active) { .markdown-comment-highlight { background: Highlight; border: 0; border-bottom: 3px solid HighlightText; color: HighlightText; } .markdown-comment-highlight-resolved { background: Canvas; border-bottom: 1px dotted CanvasText; color: CanvasText; } .markdown-comment-marker, .markdown-comment-tray, .editing-markdown, .markdown-copy-button, .editing-table-cell { border: 2px solid CanvasText; } }
    @media (max-width: 767px) { .markdown-edit-backdrop, .markdown-comment-backdrop { padding: 8px; } }
  </style>
  <title>SuperMarkdown Preview</title>
</head>
<body>
  <div id="status" class="sr-only" role="status" aria-live="polite"></div>
  <main id="preview" class="markdown-body" aria-label="Markdown preview">
    <p class="preview-loading" role="status">Rendering Markdown…</p>
  </main>
  <script nonce="${scriptNonce}">
    window.setTimeout(() => {
      if (document.documentElement.dataset.supermarkdownReady !== "true") {
        const preview = document.getElementById("preview");
        if (preview) preview.innerHTML = '<p class="preview-notice preview-notice-error" role="alert">SuperMarkdown webview failed to start. Open the “SuperMarkdown” output channel for details.</p>';
      }
    }, 5000);
  </script>
  <script nonce="${scriptNonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
