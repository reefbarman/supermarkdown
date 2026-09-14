import * as esbuild from "esbuild";

import { copyFile, cp, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
};

const webviewOptions = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
};

await mkdir("dist", { recursive: true });
await copyFile(
  "node_modules/github-markdown-css/github-markdown.css",
  "dist/github-markdown.css",
);
await copyFile("node_modules/katex/dist/katex.min.css", "dist/katex.min.css");
await cp("node_modules/katex/dist/fonts", "dist/fonts", { recursive: true });

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions),
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watching SuperMarkdown bundles...");
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions),
  ]);
}
