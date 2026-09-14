export interface SourcePosition {
  line: number;
  fraction: number;
}

interface SourceElement {
  element: HTMLElement;
  startLine: number;
  endLine: number;
  top: number;
  bottom: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function sourceElements(root: HTMLElement): SourceElement[] {
  const entries = Array.from(
    root.querySelectorAll<HTMLElement>("[data-source-line]"),
  )
    .map((element) => {
      const startLine = Number(element.dataset.sourceLine);
      const endLine = Number(element.dataset.sourceEndLine ?? startLine + 1);
      const rect = element.getBoundingClientRect();
      return {
        element,
        startLine,
        endLine,
        top: window.scrollY + rect.top,
        bottom: window.scrollY + rect.bottom,
      };
    })
    .filter(
      (entry) =>
        Number.isFinite(entry.startLine) &&
        Number.isFinite(entry.endLine) &&
        entry.endLine > entry.startLine &&
        entry.bottom > entry.top &&
        getComputedStyle(entry.element).display !== "none" &&
        getComputedStyle(entry.element).visibility !== "hidden",
    )
    .sort(
      (left, right) =>
        left.top - right.top ||
        left.startLine - right.startLine ||
        left.bottom - right.bottom,
    );

  const monotonic: SourceElement[] = [];
  for (const entry of entries) {
    const previous = monotonic.at(-1);
    if (previous && entry.startLine < previous.startLine) {
      // Plugins such as footnotes can move source blocks to the end of the DOM.
      // Exclude those reordered anchors so they cannot trap scroll interpolation.
      continue;
    }
    if (
      previous &&
      entry.startLine === previous.startLine &&
      entry.endLine === previous.endLine
    ) {
      continue;
    }
    monotonic.push(entry);
  }
  return monotonic;
}

function surroundingLine(
  entries: SourceElement[],
  line: number,
): { previous: SourceElement; next?: SourceElement } | undefined {
  let previous = entries[0];
  if (!previous) {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.startLine > line) {
      return { previous, next: entry };
    }
    previous = entry;
  }
  return { previous };
}

function surroundingOffset(
  entries: SourceElement[],
  offset: number,
): { previous: SourceElement; next?: SourceElement } | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  let previous = entries[0];
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.top > offset) {
      return { previous, next: entry };
    }
    previous = entry;
  }
  return { previous };
}

export function sourcePositionAtViewport(root: HTMLElement): SourcePosition {
  const entries = sourceElements(root);
  const target = window.scrollY + 8;
  const surrounding = surroundingOffset(entries, target);
  if (!surrounding) {
    return { line: 0, fraction: 0 };
  }

  const { previous, next } = surrounding;
  const targetBottom = next?.top ?? previous.bottom;
  const fraction = clamp(
    (target - previous.top) / Math.max(targetBottom - previous.top, 1),
    0,
    1,
  );
  const targetLine = next?.startLine ?? previous.endLine;
  return {
    line:
      previous.startLine +
      fraction * Math.max(targetLine - previous.startLine, 0),
    fraction,
  };
}

export function scrollToSourceLine(
  root: HTMLElement,
  line: number,
  behavior: ScrollBehavior = "auto",
): void {
  if (line <= 0) {
    window.scrollTo({ top: 0, behavior });
    return;
  }
  const entries = sourceElements(root);
  const surrounding = surroundingLine(entries, line);
  if (!surrounding) {
    return;
  }
  const { previous, next } = surrounding;
  let top: number;
  if (line < previous.endLine) {
    const fraction = clamp(
      (line - previous.startLine) /
        Math.max(previous.endLine - previous.startLine, 1),
      0,
      1,
    );
    top = previous.top + fraction * (previous.bottom - previous.top);
  } else if (next && next.startLine > previous.endLine) {
    const fraction = clamp(
      (line - previous.endLine) / (next.startLine - previous.endLine),
      0,
      1,
    );
    top = previous.bottom + fraction * (next.top - previous.bottom);
  } else if (next && next.startLine > previous.startLine) {
    const fraction = clamp(
      (line - previous.startLine) / (next.startLine - previous.startLine),
      0,
      1,
    );
    top = previous.bottom + fraction * (next.top - previous.bottom);
  } else {
    top = previous.bottom;
  }
  window.scrollTo({ top: Math.max(1, top - 8), behavior });
}

export async function scrollToSourceLineAfterImages(
  root: HTMLElement,
  line: number,
  shouldApply: () => boolean = () => true,
): Promise<void> {
  const pending = Array.from(
    root.querySelectorAll<HTMLImageElement>("img"),
  ).filter((image) => !image.complete);
  if (pending.length > 0) {
    await Promise.all(
      pending.map(
        (image) =>
          new Promise<void>((resolve) => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
    );
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  if (shouldApply()) {
    scrollToSourceLine(root, line);
  }
}
