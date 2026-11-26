import { describe, expect, it } from "vitest";
import { diffTextLines } from "@handbook/shared/merge";
import { diffBlocks } from "./line-diff";

describe("diff blocks", () => {
  it("folds long unchanged runs and keeps context around changes", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") + "\n";
    const after = before.replace("line 10\n", "line ten\n");
    const blocks = diffBlocks(diffTextLines(before, after));
    expect(blocks.map((block) => (block.kind === "gap" ? `gap ${block.count}` : block.lines.length))).toEqual(
      ["gap 7", 3, 2, 3, "gap 6"],
    );
  });

  it("keeps short runs whole", () => {
    const blocks = diffBlocks(diffTextLines("a\nb\nc\n", "a\nB\nc\n"));
    expect(blocks.every((block) => block.kind === "lines")).toBe(true);
  });
});
