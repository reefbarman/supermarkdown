import { describe, expect, it } from "vitest";
import {
  normalizeBlockReplacement,
  sourceMatchesHash,
  validTaskMarker,
} from "../src/edits/guards";

import { hashSource } from "../src/engine/sourceIndex";

describe("edit guards", () => {
  it("detects stale block source hashes", () => {
    const expected = hashSource("Original.\n");

    expect(sourceMatchesHash("Original.\n", expected)).toBe(true);
    expect(sourceMatchesHash("Changed.\n", expected)).toBe(false);
  });

  it("preserves LF, CRLF, and final-line newline behavior", () => {
    expect(normalizeBlockReplacement("Original.\n", "Replacement.")).toBe(
      "Replacement.\n",
    );
    expect(normalizeBlockReplacement("Original.\r\n", "Replacement.\n")).toBe(
      "Replacement.\r\n",
    );
    expect(normalizeBlockReplacement("Original.", "Replacement.\n")).toBe(
      "Replacement.",
    );
  });

  it("accepts only the exact indexed task marker", () => {
    const expected = hashSource("[ ]");

    expect(validTaskMarker("[ ]", expected)).toBe(true);
    expect(validTaskMarker("[x]", expected)).toBe(false);
    expect(validTaskMarker("yes", hashSource("yes"))).toBe(false);
  });
});
