import {
  createComment,
  emptySidecar,
  reanchorComment,
  reanchorSidecar,
} from "../src/comments/model";
import { describe, expect, it } from "vitest";
import {
  mapRenderedQuoteToSource,
  renderedQuoteOccurrenceForSource,
  renderedSegmentForSource,
} from "../src/comments/sourceMapping";

import { parseSidecar } from "../src/comments/validation";

const lineAtOffset = (source: string) => (offset: number) =>
  source.slice(0, offset).split("\n").length - 1;

describe("comment anchors", () => {
  it("creates exact offsets and quote context", () => {
    const source = "Before selected text after.";
    const start = source.indexOf("selected");
    const comment = createComment({
      source,
      sourceFile: "README.md",
      start,
      end: start + "selected".length,
      lineHint: 0,
      blockStart: 0,
      blockEnd: source.length,
      body: "Clarify this.",
      author: "Tristan",
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(comment.anchor.quote.exact).toBe("selected");
    expect(comment.anchor.quote.prefix).toContain("Before ");
    expect(comment.anchor.quote.suffix).toContain(" text after.");
  });

  it("maps rendered selections through inline formatting and list prefixes", () => {
    const source =
      "- Cargo includes **unsecured haul** and [supplies](guide.md).\n";
    const bold = mapRenderedQuoteToSource(source, "unsecured haul", 0, 1);
    const punctuation = mapRenderedQuoteToSource(
      source,
      "unsecured haul and",
      0,
      1,
    );
    const link = mapRenderedQuoteToSource(source, "supplies", 0, 1);

    expect(source.slice(bold!.start, bold!.end)).toBe("unsecured haul");
    expect(source.slice(punctuation!.start, punctuation!.end)).toBe(
      "unsecured haul** and",
    );
    expect(source.slice(link!.start, link!.end)).toBe("supplies");
    expect(
      renderedQuoteOccurrenceForSource(
        source,
        "unsecured haul and",
        punctuation!.start,
        punctuation!.end,
      ),
    ).toBe(0);
  });

  it("maps selections across soft line breaks", () => {
    const source = "Frankie the frill-neck\nwas shy as can be.\n";
    const mapping = mapRenderedQuoteToSource(
      source,
      "frill-neck\nwas shy",
      0,
      1,
    );

    expect(source.slice(mapping!.start, mapping!.end)).toBe(
      "frill-neck\nwas shy",
    );
  });

  it("projects a source range in a block to its rendered segment", () => {
    const source = "*Right*\n";
    expect(renderedSegmentForSource(source, 0, source.length)).toEqual({
      quote: "Right",
      occurrence: 0,
    });
    const repeated = "ran and ran\n";
    expect(
      renderedSegmentForSource(repeated, repeated.lastIndexOf("ran"), 11),
    ).toEqual({ quote: "ran", occurrence: 1 });
    expect(renderedSegmentForSource("text\n", 4, 5)).toBeUndefined();
  });

  it("does not confuse star list markers with emphasis delimiters", () => {
    const source = "* a *target* value\n";
    const mapping = mapRenderedQuoteToSource(source, "target value", 0, 1);

    expect(source.slice(mapping!.start, mapping!.end)).toBe("target* value");
  });

  it("refuses formatted mappings when occurrence counts differ", () => {
    const source = "- **target** and target\n";

    expect(mapRenderedQuoteToSource(source, "target", 1, 2)).toMatchObject({
      start: source.lastIndexOf("target"),
      end: source.length - 1,
    });
    expect(mapRenderedQuoteToSource(source, "target", 0, 1)).toBeUndefined();
  });

  it("stores a rendered display quote separately from the raw anchor", () => {
    const source = "- **unsecured haul** and supplies\n";
    const mapping = mapRenderedQuoteToSource(
      source,
      "unsecured haul and",
      0,
      1,
    )!;
    const comment = createComment({
      source,
      sourceFile: "README.md",
      start: mapping.start,
      end: mapping.end,
      lineHint: 0,
      blockStart: 0,
      blockEnd: source.length,
      body: "Review.",
      author: "Tristan",
      displayQuote: "unsecured haul and",
    });

    expect(comment.anchor.quote.exact).toBe("unsecured haul** and");
    expect(comment.displayQuote).toBe("unsecured haul and");
    expect(
      parseSidecar({
        ...emptySidecar("README.md", source),
        comments: [comment],
      }),
    ).toBeDefined();
  });

  it("reanchors a uniquely moved quote and preserves resolution", () => {
    const original = "Alpha target omega.";
    const start = original.indexOf("target");
    const comment = {
      ...createComment({
        source: original,
        sourceFile: "README.md",
        start,
        end: start + 6,
        lineHint: 0,
        blockStart: 0,
        blockEnd: original.length,
        body: "Review.",
        author: "Tristan",
      }),
      resolution: "resolved" as const,
    };
    const moved = "New line.\nAlpha target omega.";
    const result = reanchorComment(comment, moved, lineAtOffset(moved));

    expect(result.anchor.health).toBe("attached");
    expect(result.anchor.start).toBe(moved.indexOf("target"));
    expect(result.anchor.lineHint).toBe(1);
    expect(result.resolution).toBe("resolved");
  });

  it("does not trust an old offset when duplicate text appears", () => {
    const source = "target";
    const comment = createComment({
      source,
      sourceFile: "README.md",
      start: 0,
      end: 6,
      lineHint: 0,
      blockStart: 0,
      blockEnd: source.length,
      body: "Review.",
      author: "Tristan",
    });

    expect(
      reanchorComment(
        comment,
        "target and target",
        lineAtOffset("target and target"),
      ).anchor.health,
    ).toBe("ambiguous");
    expect(
      reanchorComment(comment, "gone", lineAtOffset("gone")).anchor.health,
    ).toBe("orphaned");
  });

  it("validates and reanchors complete sidecars", () => {
    const source = "Text.";
    const sidecar = emptySidecar("README.md", source);
    const parsed = parseSidecar(JSON.parse(JSON.stringify(sidecar)));

    expect(parsed).toBeDefined();
    expect(reanchorSidecar(parsed!, source, lineAtOffset(source)).version).toBe(
      1,
    );
    expect(parseSidecar({ version: 2 })).toBeUndefined();
    expect(
      parseSidecar({
        ...sidecar,
        comments: [
          {
            id: "c-invalid",
            author: "Tristan",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            resolution: "open",
            anchor: {
              health: "attached",
              start: 5,
              end: 2,
              lineHint: -1,
              blockHash: "sha256:test",
              quote: { exact: "x", prefix: "", suffix: "" },
            },
            body: "Invalid.",
          },
        ],
      }),
    ).toBeUndefined();
  });
});
