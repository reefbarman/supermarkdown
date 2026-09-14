declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";

  const footnote: MarkdownIt.PluginSimple;
  export default footnote;
}

declare module "markdown-it-emoji" {
  import type MarkdownIt from "markdown-it";

  export const full: MarkdownIt.PluginSimple;
  export const light: MarkdownIt.PluginSimple;
  export const bare: MarkdownIt.PluginSimple;
}
