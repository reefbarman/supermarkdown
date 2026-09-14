import DOMPurify from "dompurify";
import mermaid from "mermaid";

let initializedTheme: "default" | "dark" | undefined;

function currentTheme(): "default" | "dark" {
  return document.body.classList.contains("vscode-dark") ||
    document.body.classList.contains("vscode-high-contrast")
    ? "dark"
    : "default";
}

function initialize(): void {
  const theme = currentTheme();
  if (initializedTheme === theme) {
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  });
  initializedTheme = theme;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const parseLine = /Parse error on line \d+/iu.exec(error.message)?.[0];
    return (
      parseLine ?? error.message.split("\n")[0] ?? "Unable to render diagram."
    );
  }
  return "Unable to render diagram.";
}

function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeMermaidSvg(svg: string): string {
  const sanitized = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "script", "image", "a"],
    FORBID_ATTR: ["href", "xlink:href", "onload", "onclick", "onerror"],
  });
  const parsed = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  for (const style of Array.from(parsed.querySelectorAll("style"))) {
    style.textContent = (style.textContent ?? "")
      .replace(/@import[^;]+;?/giu, "")
      .replace(/url\(\s*["']?(?!#)[^)]*\)/giu, "none");
  }
  for (const element of Array.from(
    parsed.querySelectorAll<SVGElement>("[style]"),
  )) {
    element.setAttribute(
      "style",
      (element.getAttribute("style") ?? "").replace(
        /url\(\s*["']?(?!#)[^)]*\)/giu,
        "none",
      ),
    );
  }
  return new XMLSerializer().serializeToString(parsed.documentElement);
}

export async function renderMermaidDiagrams(
  root: ParentNode,
  generation: number,
): Promise<void> {
  initialize();
  const diagrams = Array.from(
    root.querySelectorAll<HTMLElement>(".mermaid-diagram"),
  );

  for (const [index, diagram] of diagrams.entries()) {
    const source = diagram.querySelector<HTMLElement>(".mermaid-source");
    const output = diagram.querySelector<HTMLElement>(".mermaid-output");
    if (!source || !output) {
      continue;
    }

    const sourceKey = diagram.dataset.sourceKey ?? "";
    if (
      sourceKey &&
      output.dataset.renderedSourceKey === sourceKey &&
      output.querySelector("svg")
    ) {
      source.hidden = true;
      continue;
    }

    try {
      const id = `supermarkdown-mermaid-${generation}-${index}`;
      const result = await mermaid.render(id, source.textContent ?? "");
      const svg = sanitizeMermaidSvg(result.svg);
      output.innerHTML = svg;
      output.dataset.renderedSourceKey = sourceKey;
      source.hidden = true;
      diagram.classList.remove("mermaid-error");
    } catch (error) {
      output.replaceChildren();
      delete output.dataset.renderedSourceKey;
      const message = document.createElement("p");
      message.className = "mermaid-error-message";
      message.textContent = `Mermaid: ${errorMessage(error)}`;
      const details = document.createElement("pre");
      details.className = "mermaid-error-details";
      details.textContent = errorDetails(error);
      output.append(message, details);
      source.hidden = false;
      diagram.classList.add("mermaid-error");
    }
  }
}
