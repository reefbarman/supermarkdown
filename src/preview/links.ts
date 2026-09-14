import * as path from "node:path";
import * as vscode from "vscode";

import { classifyRawLink } from "./linkPolicy";

const MARKDOWN_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkdn",
  ".mkd",
]);

export type LinkAction =
  | { type: "anchor"; fragment: string }
  | { type: "external"; uri: vscode.Uri }
  | { type: "file"; uri: vscode.Uri; fragment: string; markdown: boolean }
  | { type: "blocked" };

function decodePath(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function classifyLink(
  documentUri: vscode.Uri,
  href: string,
): LinkAction {
  const raw = classifyRawLink(href);
  if (raw.kind === "anchor") {
    return { type: "anchor", fragment: raw.fragment };
  }
  if (raw.kind === "external") {
    return { type: "external", uri: vscode.Uri.parse(raw.path, true) };
  }
  if (raw.kind === "blocked") {
    return { type: "blocked" };
  }

  const decoded = decodePath(raw.path);
  if (decoded === undefined) {
    return { type: "blocked" };
  }
  const uri = decoded
    ? vscode.Uri.joinPath(documentUri, "..", decoded).with({ fragment: "" })
    : documentUri.with({ fragment: "" });
  return {
    type: "file",
    uri,
    fragment: raw.fragment,
    markdown: MARKDOWN_EXTENSIONS.has(path.extname(uri.path).toLowerCase()),
  };
}

export interface LocalImageReference {
  key: string;
  uri: vscode.Uri;
  webviewUri: vscode.Uri;
}

export function rewriteLocalImageSources(
  html: string,
  documentUri: vscode.Uri,
  webview: vscode.Webview,
  allowRemoteImages: boolean,
  resourceRoot?: vscode.Uri,
  localImages: LocalImageReference[] = [],
): string {
  const keys = new Map<string, string>();
  return html.replace(
    /(<img\b[^>]*\bsrc=")([^"]+)(")/giu,
    (match, prefix, source, suffix) => {
      const decodedSource = source.replaceAll("&amp;", "&");
      const scheme = /^([a-z][a-z\d+.-]*):/iu
        .exec(decodedSource)?.[1]
        .toLowerCase();
      if (scheme === "http" || scheme === "https") {
        return allowRemoteImages ? match : `${prefix}${suffix}`;
      }
      if (scheme) {
        return `${prefix}${suffix}`;
      }

      const decoded = decodePath(decodedSource.split(/[?#]/u, 1)[0]);
      if (!decoded) {
        return match;
      }
      const resource = vscode.Uri.joinPath(documentUri, "..", decoded);
      const caseInsensitiveFileSystem =
        resource.scheme === "file" &&
        (process.platform === "darwin" || process.platform === "win32");
      const resourcePath = caseInsensitiveFileSystem
        ? resource.path.toLowerCase()
        : resource.path;
      const rootPath = caseInsensitiveFileSystem
        ? resourceRoot?.path.toLowerCase()
        : resourceRoot?.path;
      if (
        resourceRoot &&
        (resource.scheme !== resourceRoot.scheme ||
          resource.authority !== resourceRoot.authority ||
          !resourcePath.startsWith(`${rootPath?.replace(/\/$/u, "")}/`))
      ) {
        return `${prefix}${suffix}`;
      }
      const resourceKey = resource.toString();
      const key = keys.get(resourceKey) ?? `image-${keys.size}`;
      keys.set(resourceKey, key);
      const webviewUri = webview.asWebviewUri(resource);
      if (!localImages.some((image) => image.key === key)) {
        localImages.push({ key, uri: resource, webviewUri });
      }
      return `${prefix}${webviewUri.toString()}${suffix} data-supermarkdown-image-key="${key}"`;
    },
  );
}
