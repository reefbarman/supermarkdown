import { describe, expect, it } from "vitest";

import { classifyRawLink } from "../src/preview/linkPolicy";

describe("classifyRawLink", () => {
  it("classifies anchors, external links, and relative files", () => {
    expect(classifyRawLink("#section")).toEqual({
      kind: "anchor",
      path: "",
      fragment: "section",
      scheme: "",
    });
    expect(classifyRawLink("https://example.com/path")).toEqual({
      kind: "external",
      path: "https://example.com/path",
      fragment: "",
      scheme: "https",
    });
    expect(classifyRawLink("../guide.md#start")).toEqual({
      kind: "file",
      path: "../guide.md",
      fragment: "start",
      scheme: "",
    });
  });

  it("blocks command and script schemes", () => {
    expect(classifyRawLink("command:workbench.action.closeWindow").kind).toBe(
      "blocked",
    );
    expect(classifyRawLink("javascript:alert(1)").kind).toBe("blocked");
    expect(classifyRawLink("file:///etc/passwd").kind).toBe("blocked");
  });
});
