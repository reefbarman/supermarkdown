export type RawLinkKind = "anchor" | "external" | "file" | "blocked";

export interface RawLinkTarget {
  kind: RawLinkKind;
  path: string;
  fragment: string;
  scheme: string;
}

const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"]);

export function classifyRawLink(href: string): RawLinkTarget {
  const trimmed = href.trim();
  if (!trimmed) {
    return { kind: "blocked", path: "", fragment: "", scheme: "" };
  }
  if (trimmed.startsWith("#")) {
    return {
      kind: "anchor",
      path: "",
      fragment: trimmed.slice(1),
      scheme: "",
    };
  }

  const schemeMatch = /^([a-z][a-z\d+.-]*):/iu.exec(trimmed);
  const scheme = schemeMatch?.[1].toLowerCase() ?? "";
  if (EXTERNAL_SCHEMES.has(scheme)) {
    return {
      kind: "external",
      path: trimmed,
      fragment: "",
      scheme,
    };
  }
  if (scheme) {
    return { kind: "blocked", path: "", fragment: "", scheme };
  }

  const hashIndex = trimmed.indexOf("#");
  return {
    kind: "file",
    path: hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed,
    fragment: hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "",
    scheme,
  };
}
