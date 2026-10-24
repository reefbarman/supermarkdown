# SuperMarkdown

A personal VS Code Markdown preview with a local GitHub-compatible renderer, reliable Mermaid diagrams, preview editing, and agent-readable review comments.

## Features

- Local GFM-style rendering with tables, task lists, alerts, footnotes, emoji, KaTeX math, VS Code-style Highlight.js code highlighting, and bundled Mermaid
- One preview panel per Markdown file, live keyed refresh, two-way scroll sync, and panel restoration
- Safe relative links, heading anchors, watched local images, and blocked remote images by default
- Raw-Markdown editing for safely mapped headings, paragraphs, fenced code, math, tables, lists, and blockquotes/alerts
- Direct table-cell editing in the preview, with guarded updates to the underlying Markdown
- Accessible code-copy controls and clickable task-list checkboxes backed by exact source offsets
- Selection comments stored beside the Markdown file as `<file>.md.comments.json`

## Use

- `Cmd+Shift+V` / `Ctrl+Shift+V`: open SuperMarkdown preview
- `Cmd+K V` / `Ctrl+K V`: open preview to the side
- Hover a supported rendered block and choose **Edit**, or double-click it
- Click a plain table cell, or focus it and press `Enter`, to edit its value directly
- Select text (within one block or across several) and choose **Comment**

Each preview panel stays bound to the file it was opened for. Opening a preview for another file, or following a Markdown link in the preview, opens a separate panel for that file.
- Run **SuperMarkdown: Open Comments Sidecar** to inspect or provide comments to an agent

Markdown-block edits apply with `Cmd/Ctrl+Enter`. Table-cell edits apply with `Enter` or when focus leaves the cell. Both cancel with `Esc`. Successful preview edits and task toggles automatically save the Markdown file to disk. Comments can be resolved, reopened, or deleted from the preview.

## Settings

- `supermarkdown.takeOverKeybindings`
- `supermarkdown.liveUpdateDelay`
- `supermarkdown.scrollPreviewWithEditor`
- `supermarkdown.scrollEditorWithPreview`
- `supermarkdown.preserveScrollOnUpdate`
- `supermarkdown.openMarkdownLinks`
- `supermarkdown.allowRemoteImages`
- `supermarkdown.commentAuthor`

SuperMarkdown reuses compatible `markdown.preview.*` settings for line breaks, linkification, typography, front matter, font family/size, line height, scrolling, and link behavior. It also follows Markdown editor word-wrap and scroll-beyond-last-line settings unless a SuperMarkdown-specific override is configured. Local image auto-refresh depends on the active filesystem provider supporting VS Code file watchers; unsupported remote/read-only providers still render images but may require **Refresh Preview** after an image changes.

Remote images are allowed only when explicitly enabled in a trusted workspace. Raw Markdown HTML and Mermaid SVG output are sanitized. Documents are capped at 2,000,000 characters to bound parser complexity.

### Dependency audit notes

`npm audit --omit=dev` currently reports two moderate advisories with no upstream fix:

- `markdown-it` parser complexity: mitigated by the document-size limit and disabled typographer/smartquotes
- `sanitize-html` URI handling for form/media attributes: mitigated by SuperMarkdown's strict tag/attribute allowlist, which excludes the affected attributes

## Install a local build

```bash
npm install
npm run typecheck
npm test
npm run package -- releases/supermarkdown-dev.vsix
code --install-extension releases/supermarkdown-dev.vsix --force
```

Validate the complete release pipeline without bumping or installing:

```bash
npm run release -- --dry-run
```

Release and install to the default and named VS Code profiles:

```bash
npm run release -- --install
```

This bumps the patch version by default. Use `--minor` or `--major` when needed.

## Smoke test

- [ ] Open a Markdown file with the toolbar button, standard shortcut, and “to the side” shortcut
- [ ] Confirm GFM tables/tasks/alerts, math, highlighted code, and valid/invalid Mermaid diagrams render
- [ ] Edit source and confirm live refresh, preserved scroll, and two-way scroll sync
- [ ] Open relative links/anchors and local images; modify/create an image and confirm it refreshes without reparsing Markdown; confirm blocked images show a readable fallback
- [ ] Copy a rendered code block and confirm the exact source reaches the clipboard
- [ ] Change compatible `markdown.preview.*` typography/rendering settings and confirm the preview refreshes
- [ ] Edit a heading, paragraph, code fence, formula, table, list, and alert; confirm save, cancel, conflict handling, and VS Code undo
- [ ] Edit table header/body cells directly; confirm `Enter`, blur, `Esc`, pipes, missing cells, conflict handling, and undo
- [ ] Toggle nested and numbered task checkboxes; confirm source updates and undo
- [ ] Select text, add a comment, resolve/reopen/delete it, and open the JSON sidecar
- [ ] Add several comments in a row, including multi-line and multi-block selections
- [ ] Open previews for two Markdown files and confirm each keeps rendering its own file when switching editors
- [ ] Modify the sidecar externally and confirm the preview refreshes without overwriting conflicts
- [ ] Reload VS Code and confirm each preview and its scroll position restore
- [ ] Check keyboard-only focus, `Esc`, `Cmd/Ctrl+Enter`, light/dark/high-contrast themes, and reduced motion

Development is tracked locally in `plans/supermarkdown-extension-plan.md`.
