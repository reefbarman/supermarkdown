export interface RenderedQuoteMapping {
  start: number;
  end: number;
}

interface Projection {
  text: string;
  starts: number[];
  ends: number[];
}

function escaped(source: string, index: number): boolean {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === "\\";
    cursor -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function omitLinePrefixes(source: string, omitted: boolean[]): void {
  let lineStart = 0;
  while (lineStart < source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);
    const prefix =
      /^[ \t]*(?:(?:>[ \t]*)+)?(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:\[[ xX]\][ \t]+)?/u.exec(
        line,
      )?.[0];
    if (prefix) {
      for (
        let index = lineStart;
        index < lineStart + prefix.length;
        index += 1
      ) {
        omitted[index] = true;
      }
    }
    lineStart = lineEnd + 1;
  }
}

function omitPairedDelimiter(
  source: string,
  omitted: boolean[],
  delimiter: string,
  accept: (index: number) => boolean = () => true,
): void {
  const positions: number[] = [];
  let offset = 0;
  while (offset <= source.length - delimiter.length) {
    const found = source.indexOf(delimiter, offset);
    if (found < 0) {
      break;
    }
    if (!omitted[found] && !escaped(source, found) && accept(found)) {
      positions.push(found);
    }
    offset = found + delimiter.length;
  }
  for (let index = 0; index + 1 < positions.length; index += 2) {
    for (const position of [positions[index], positions[index + 1]]) {
      for (
        let cursor = position;
        cursor < position + delimiter.length;
        cursor += 1
      ) {
        omitted[cursor] = true;
      }
    }
  }
}

function omitInlineSyntax(source: string, omitted: boolean[]): void {
  for (const match of source.matchAll(/!?\[([^\]\n]+)\]\(([^)\n]*)\)/gu)) {
    const start = match.index;
    const labelStart = start + (match[0].startsWith("!") ? 2 : 1);
    const labelEnd = labelStart + match[1].length;
    for (let index = start; index < labelStart; index += 1) {
      omitted[index] = true;
    }
    for (let index = labelEnd; index < start + match[0].length; index += 1) {
      omitted[index] = true;
    }
  }

  omitPairedDelimiter(source, omitted, "**");
  omitPairedDelimiter(source, omitted, "__");
  omitPairedDelimiter(source, omitted, "~~");
  omitPairedDelimiter(
    source,
    omitted,
    "*",
    (index) => source[index - 1] !== "*" && source[index + 1] !== "*",
  );
  omitPairedDelimiter(source, omitted, "_", (index) => {
    if (source[index - 1] === "_" || source[index + 1] === "_") {
      return false;
    }
    return !(
      /[\p{L}\p{N}]/u.test(source[index - 1] ?? "") &&
      /[\p{L}\p{N}]/u.test(source[index + 1] ?? "")
    );
  });

  for (const match of source.matchAll(/(`+)([^\n]*?)\1/gu)) {
    const start = match.index;
    const delimiterLength = match[1].length;
    for (let index = start; index < start + delimiterLength; index += 1) {
      omitted[index] = true;
    }
    for (
      let index = start + match[0].length - delimiterLength;
      index < start + match[0].length;
      index += 1
    ) {
      omitted[index] = true;
    }
  }

  for (let index = 0; index + 1 < source.length; index += 1) {
    if (
      source[index] === "\\" &&
      /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.test(source[index + 1])
    ) {
      omitted[index] = true;
    }
  }
}

function projectSource(source: string): Projection {
  const omitted = Array.from({ length: source.length }, () => false);
  omitLinePrefixes(source, omitted);
  omitInlineSyntax(source, omitted);

  const text: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (omitted[index]) {
      continue;
    }
    text.push(source[index]);
    starts.push(index);
    ends.push(index + 1);
  }
  return { text: text.join(""), starts, ends };
}

export function renderedQuoteMappings(
  blockSource: string,
  quote: string,
): RenderedQuoteMapping[] {
  if (!quote) {
    return [];
  }
  const projection = projectSource(blockSource);
  const mappings: RenderedQuoteMapping[] = [];
  let offset = 0;
  while (offset <= projection.text.length - quote.length) {
    const found = projection.text.indexOf(quote, offset);
    if (found < 0) {
      break;
    }
    const endIndex = found + quote.length - 1;
    mappings.push({
      start: projection.starts[found],
      end: projection.ends[endIndex],
    });
    offset = found + quote.length;
  }
  return mappings;
}

export function mapRenderedQuoteToSource(
  blockSource: string,
  quote: string,
  occurrence: number,
  expectedCount: number,
): RenderedQuoteMapping | undefined {
  const mappings = renderedQuoteMappings(blockSource, quote);
  if (mappings.length !== expectedCount) {
    return undefined;
  }
  return mappings[occurrence];
}

export interface RenderedSegment {
  quote: string;
  occurrence: number;
}

/**
 * Projects a source range inside a block to the rendered text a reader sees,
 * returning that text and which non-overlapping occurrence of it the range is.
 */
export function renderedSegmentForSource(
  blockSource: string,
  start: number,
  end: number,
): RenderedSegment | undefined {
  const projection = projectSource(blockSource);
  let first = projection.starts.findIndex((index) => index >= start);
  if (first < 0) {
    return undefined;
  }
  let last = first;
  while (last < projection.starts.length && projection.starts[last] < end) {
    last += 1;
  }
  while (first < last && /\s/u.test(projection.text[first])) {
    first += 1;
  }
  while (last > first && /\s/u.test(projection.text[last - 1])) {
    last -= 1;
  }
  if (last <= first) {
    return undefined;
  }
  const quote = projection.text.slice(first, last);
  let occurrence = 0;
  let offset = 0;
  while (offset <= first) {
    const found = projection.text.indexOf(quote, offset);
    if (found < 0 || found >= first) {
      break;
    }
    occurrence += 1;
    offset = found + quote.length;
  }
  return { quote, occurrence };
}

export function renderedQuoteOccurrenceForSource(
  blockSource: string,
  quote: string,
  start: number,
  end: number,
): number | undefined {
  const mappings = renderedQuoteMappings(blockSource, quote);
  const occurrence = mappings.findIndex(
    (mapping) => mapping.start === start && mapping.end === end,
  );
  return occurrence < 0 ? undefined : occurrence;
}
