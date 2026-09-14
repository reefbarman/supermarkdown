# SuperMarkdown — VS Code Markdown Preview Replacement

## Goal

Build a personal-use VS Code extension that replaces the daily workflow of the built-in Markdown preview with:

1. A pinned, local **GitHub-compatible rendering profile** with reliable bundled Mermaid
2. Conservative block-level editing from the rendered preview
3. Selection-anchored comments in an adjacent, agent-readable JSON sidecar
4. Daily-use parity with VS Code's preview: open/to-side, follow/lock, live refresh, find, source navigation, two-way scroll sync, links/images, themes, and settings

“GitHub-compatible” means GFM behavior and GitHub-like styling covered by checked fixtures. A local renderer cannot honestly promise byte-for-byte parity with GitHub's evolving private rendering pipeline.

## Confirmed Scope

| Decision     | v1 choice                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------- |
| Rendering    | Fully local and offline; no GitHub API                                                      |
| Editing      | Block-level edit-in-place, with a source-editor fallback                                    |
| Comments     | Adjacent `<file>.md.comments.json` sidecar                                                  |
| Extra syntax | Mermaid, math, alerts, task lists, emoji, footnotes, syntax highlighting                    |
| Preview UX   | Live refresh, two-way scroll sync, relative links/images/anchors, clickable task checkboxes |
| Keybindings  | Prefer SuperMarkdown for `Cmd+Shift+V` and `Cmd+K V`, with an opt-out                       |
| Distribution | Personal VSIX using the same release/install pattern as AgentLink                           |
| Export       | HTML and PDF export are deferred                                                            |

## Technical Direction

- **Extension/build:** TypeScript with esbuild bundles for the Node extension host and browser webview. Vanilla TypeScript in the webview, with `morphdom` for keyed DOM updates.
- **Markdown:** `markdown-it`, selected because its block token ranges are useful for preview navigation. A separate source index—not raw `token.map` alone—owns editing and comment anchors.
- **Syntax:** custom/maintained plugins for task lists and GitHub alerts; footnotes, emoji, math, GitHub heading slugs, and front matter behavior. Pin dependency versions.
- **Code highlighting:** Highlight.js with VS Code's bundled Markdown preview palettes.
- **Styling:** `github-markdown-css`, adapted to VS Code theme variables.
- **Mermaid:** pinned and bundled locally; strict security mode; no CDN, click callbacks, external resource loading, or arbitrary links. Cache keys include Mermaid version, config, theme, diagram identity, and source hash.
- **Math:** locally bundled KaTeX CSS/fonts.
- **Validation/security:** schema-validate extension↔webview messages and sidecars. Sanitize final Markdown HTML and Mermaid SVG with tested tag/attribute/protocol allowlists.

## Architecture

```text
src/
├── extension.ts             # activation and commands
├── engine/
│   ├── renderer.ts          # markdown-it pipeline and sanitization
│   ├── sourceIndex.ts       # navigation anchors + exact editable-block descriptors
│   └── compatibility.ts     # pinned GitHub-compatible profile
├── preview/
│   ├── PreviewManager.ts    # panel follow/lock/restore lifecycle
│   ├── resources.ts         # CSP, local/remote resource policy, URI rewriting
│   └── protocol.ts          # validated extension↔webview messages
├── edits/EditService.ts     # guarded block replacement and checkbox toggles
└── comments/CommentStore.ts # sidecar validation, merge-safe writes, re-anchoring
webview/
├── main.ts                  # keyed updates and stale-generation rejection
├── mermaid.ts               # safe, cached diagram rendering
├── scrollSync.ts            # indexed/interpolated two-way sync
├── editOverlay.ts           # block editor and source fallback
└── comments.ts              # selection mapping, highlights, comment controls
```

### Render result and source index

Every render has `{ uri, documentVersion, generation }`. Only the latest generation may update the webview.

The renderer emits two related indexes:

1. **Navigation anchors** for scroll sync: filtered, sorted visible block anchors with source lines, rendered element IDs, and range lengths. Duplicate/container-only token ranges are removed. Scroll mapping interpolates between anchors and carries a fractional source position; origin/revision IDs suppress echo loops.
2. **Editable blocks** with stable per-render IDs, block type, parent/depth, exact source start/end offsets, line range, raw-slice hash, and explicit editability. This prevents overlapping `markdown-it` token maps from authorizing unsafe replacements.

Phase 0 includes a go/no-go spike against nested lists, blockquotes, tables, setext headings, fenced code, HTML blocks, duplicate lines, blank lines, CRLF, and files without a final newline. If a construct cannot be mapped safely, previewing still works and editing falls back to “Open source at line.”

### Live refresh and Mermaid

Document changes are debounced (default 250 ms). Asynchronous render results carry their generation and are discarded when stale. `morphdom` keys blocks by render identity and only preserves state when the source block identity/hash still matches. Theme/config changes invalidate relevant caches.

Mermaid runs from the bundled webview asset. Unchanged diagrams retain their SVG; duplicate diagrams receive unique SVG ID namespaces so markers and links cannot collide. Parse failures produce an inline error with an “Edit source” action rather than silently disappearing.

### Preview editing

- Hover/double-click an editable block to open an autosizing raw-Markdown textarea.
- Initial safe types are headings, standalone paragraphs, and fenced code. Additional containers (list items, blockquotes, tables) are enabled only after their mapping fixtures pass.
- Save with `Cmd+Enter`; cancel with `Esc`.
- Before applying a `WorkspaceEdit`, revalidate the URI, document version, exact range, and original-slice hash. Preserve the document's EOL and final-newline behavior.
- If validation fails or the block is not safely editable, keep the user's draft and offer “Open source at line.”
- Task checkboxes carry their exact source offset and expected marker; toggles revalidate both before changing `[ ]`/`[x]`.

## Comments

### Selection rules

v1 accepts selections that map unambiguously to one source-backed block. It rejects generated or ambiguous selections (for example rendered-only math/emoji output, selections spanning blocks, or repeated text without a unique contextual match) rather than guessing.

For accepted selections, the extension records exact source offsets plus a Web Annotation-style text quote selector (`exact`, `prefix`, `suffix`). Re-anchoring tries the stored range/hash first, then a unique contextual quote match nearest the old line. Ambiguous or missing anchors become unhealthy/orphaned; they never silently move.

### Sidecar schema

```json
{
  "version": 1,
  "source": {
    "file": "README.md",
    "contentHash": "sha256:..."
  },
  "updatedAt": "2026-08-26T10:00:00Z",
  "comments": [
    {
      "id": "c-01J...",
      "author": "Tristan",
      "createdAt": "2026-08-26T10:00:00Z",
      "updatedAt": "2026-08-26T10:00:00Z",
      "resolution": "open",
      "anchor": {
        "health": "attached",
        "start": 412,
        "end": 435,
        "lineHint": 12,
        "blockHash": "sha256:...",
        "quote": {
          "exact": "the selected text",
          "prefix": "text immediately before ",
          "suffix": " text immediately after"
        }
      },
      "body": "Add a concrete example."
    }
  ]
}
```

Resolution (`open`/`resolved`) and anchor health (`attached`/`ambiguous`/`orphaned`) are independent.

### Sidecar lifecycle

- Comments require a saved, writable, file-backed Markdown document. If the source is dirty, “Add comment” asks the user to save first. Untitled/read-only documents remain previewable but cannot create sidecars.
- Use `vscode.workspace.fs` so supported remote workspaces work. The sidecar is next to the Markdown file and uses a relative source filename.
- Validate schema versions before use. A malformed or future-version sidecar is never overwritten; show an error and open it for repair.
- Serialize in-extension writes. Before each mutation, re-read the latest sidecar and merge by comment ID. If the same comment changed externally or the sidecar is open and dirty, stop and ask the user to resolve/save rather than clobbering it.
- Watch source and sidecar changes. Move the sidecar on VS Code-observed source renames; do not automatically delete comments when a source file is deleted.

## Security and Trust Boundary

Markdown files, Mermaid source, sidecars, links, and webview messages are untrusted.

- CSP: `default-src 'none'`; nonce-only bundled scripts; `webview.cspSource` for local styles/fonts/images; no frames, objects, forms, workers, network connections, or inline scripts.
- Render raw HTML only through a strict sanitizer. Allow only required GitHub/KaTeX/Highlight.js tags, classes, attributes, style properties, and URL schemes. Strip scripts, event handlers, forms, `<base>`, embedded frames/objects, and UI-spoofing attributes.
- Sanitize Mermaid SVG after strict rendering; disable click handlers and external resource loading.
- Validate every webview message again in the extension host. Never trust a webview-provided URI, range, offset, command, or hash.
- Local images are resolved through `asWebviewUri` and bounded `localResourceRoots`.
- Remote images/content are blocked by default and always blocked in untrusted workspaces. A setting can permit HTTPS images in trusted workspaces; links still open through VS Code rather than navigating the webview.
- Custom JavaScript/plugin injection is intentionally unsupported. Optional custom CSS, if added, is workspace-trust gated and isolated from extension controls.

## v1 Preview Parity Matrix

### Included

- Open Preview and Open Preview to Side
- Follow active Markdown editor and Toggle Preview Lock
- Live refresh and explicit Refresh
- Built-in webview find widget
- Double-click/edit-source navigation and editor-selection highlighting
- Two-way scroll sync with independently configurable source→preview and preview→source directions
- Relative Markdown links, heading anchors using GitHub slug rules, external links, and local images
- Image-file watching and refresh
- Front matter setting; line-break, linkify, typographer, font, line-height, word-wrap, and scroll-beyond-last-line settings where practical, including compatible reuse of existing `markdown.preview.*` values
- Theme-aware GitHub-style rendering, code-copy control, task checkbox updates
- Missing-file/error states, workspace trust restrictions, panel restoration
- Explorer/editor context commands plus a SuperMarkdown editor-title button

### Replacement limits

- Keybindings prefer SuperMarkdown via precise editor-focus and `activeWebviewPanelId` clauses, including macOS-specific keys. User keybindings and later-contributed extension bindings can still win. `supermarkdown.takeOverKeybindings` disables the preference.
- The built-in preview commands/button cannot be removed by another extension. Disabling VS Code's built-in Markdown extension is not recommended because it also removes Markdown language features.
- v1 does not support arbitrary contributed Markdown preview scripts/plugins, custom-editor/diff preview paths, full WYSIWYG editing, cross-file comment dashboards, or HTML/PDF export.

## Delivery Phases

Each phase ends in an installable VSIX and a concise smoke checklist.

1. **Scaffold and feasibility gate**
   - Extension manifest, TypeScript/esbuild, tests, minimal webview, strict CSP shell
   - Adapt `scripts/release.sh`: version bump → package to `releases/supermarkdown-<version>.vsix` → optional `--install` to default and named VS Code profiles
   - Mirror AgentLink's `.agentlink/tasks.json` release patch/minor and test tasks
   - Prototype and fixture-test source indexing, guarded edits, scroll interpolation, sanitizer, bundled Mermaid, and KaTeX font loading
2. **GitHub-compatible rendering**
   - Pinned GFM profile, alerts, footnotes, emoji, math, Highlight.js, GitHub CSS, Mermaid errors/caching
   - Compatibility fixtures and documented dependency-update policy
3. **Preview parity**
   - Panel lifecycle, keyed/stale-safe refresh, find, settings, links/images/anchors, image watching, source navigation, selection marking, two-way scroll sync, keybinding preference
4. **Interactive editing**
   - Safe block editor, exact-offset checkbox toggles, conflict/source fallback UX
5. **Comments**
   - Selection mapping, sidecar store/watcher, highlights and margin markers, re-anchoring, resolve/delete, “Open comments sidecar” command
6. **Polish and local release**
   - Error/accessibility states, final security and remote-workspace checks, VSIX install smoke test

## Validation

- **Compatibility fixtures:** GFM tables/task lists/strikethrough/autolinks, alerts, footnotes, emoji, math, heading slugs, raw HTML sanitization, Mermaid successes/failures
- **Mapping/edit fixtures:** nested containers, tables, duplicate text, generated text, CRLF/final newline, stale versions, ambiguous comments
- **Extension/webview integration:** panel follow/lock/restore, keybinding contexts, links/URIs, image watching, out-of-order renders, theme/cache invalidation, sidecar external edits
- **Security fixtures:** malicious Markdown HTML, URL schemes, Mermaid directives/SVG, malformed protocol messages, untrusted workspace and remote-image behavior
- **Manual smoke:** package/install VSIX; open/to-side/lock; edit; checkbox; comment/re-anchor/resolve; Mermaid/math; light/dark; local/remote workspace paths

## Rollback and Data Safety

- All source mutations use `WorkspaceEdit`, so normal VS Code undo applies.
- Sidecars are ordinary versioned JSON; the extension never silently discards malformed, future, conflicted, ambiguous, or orphaned comments.
- The takeover setting restores the built-in preview keybinding behavior without uninstalling SuperMarkdown.
- Each delivery phase remains packageable, so regressions can be isolated or reverted before later capabilities are enabled.
