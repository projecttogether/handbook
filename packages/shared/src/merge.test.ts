import { describe, expect, it } from "vitest";
import {
  applyEdits,
  diffTextLines,
  hasConflictMarkers,
  lineStats,
  mergeText,
  type EditResult,
} from "./merge";

describe("merging", () => {
  const base = "a\nb\nc\nd\n";
  it("combines changes in different places", () => {
    expect(mergeText(base, "A\nb\nc\nd\n", "a\nb\nc\nD\n")).toEqual({
      clean: true,
      text: "A\nb\nc\nD\n",
      conflicts: 0,
    });
  });
  it("marks overlapping changes", () => {
    const result = mergeText(base, "a\nX\nc\nd\n", "a\nY\nc\nd\n");
    expect(result.clean).toBe(false);
    expect(result.text).toBe("a\n<<<<<<< yours\nX\n=======\nY\n>>>>>>> current\nc\nd\n");
    expect(hasConflictMarkers(result.text)).toBe(true);
  });
  it("applies exact edits once", () => {
    expect(applyEdits("one two one", [{ oldText: "two", newText: "2" }])).toEqual({
      ok: true,
      text: "one 2 one",
    });
    expect(applyEdits("one two one", [{ oldText: "one", newText: "1" }]).ok).toBe(false);
    expect(applyEdits("one two one", [{ oldText: "one", newText: "1", replaceAll: true }])).toEqual({
      ok: true,
      text: "1 two 1",
    });
    expect(applyEdits("abc", [{ oldText: "x", newText: "y" }]).ok).toBe(false);
  });
  it("counts lines", () => {
    expect(lineStats("a\nb\n", "a\nc\nd\n")).toEqual({ added: 2, removed: 1 });
  });
});

describe("merging within paragraphs", () => {
  const base = "# VPN\n\nConnect from home with the client. Ask IT for an account.\n\nEnd.\n";
  it("combines changes to different words of one paragraph", () => {
    const yours = base.replace("from home", "from anywhere");
    const current = base.replace("Ask IT", "Ask the helpdesk");
    expect(mergeText(base, yours, current)).toEqual({
      clean: true,
      text: "# VPN\n\nConnect from anywhere with the client. Ask the helpdesk for an account.\n\nEnd.\n",
      conflicts: 0,
    });
  });
  it("combines a changed word with a line added next to it", () => {
    const yours = base.replace("the client", "the new client");
    const current = base.replace("an account.\n", "an account.\nIt takes a day.\n");
    expect(mergeText(base, yours, current)).toEqual({
      clean: true,
      text: "# VPN\n\nConnect from home with the new client. Ask IT for an account.\nIt takes a day.\n\nEnd.\n",
      conflicts: 0,
    });
  });
  it("marks changes to the same words, with the whole lines", () => {
    const result = mergeText(base, base.replace("home", "the office"), base.replace("home", "a café"));
    expect(result.clean).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe(
      "# VPN\n\n<<<<<<< yours\nConnect from the office with the client. Ask IT for an account.\n=======\nConnect from a café with the client. Ask IT for an account.\n>>>>>>> current\n\nEnd.\n",
    );
  });
  it("marks changes whose words a diff could match in two ways", () => {
    // Both sides turned "b" into "a" and changed a different "a": the two
    // diffs match different copies of "a", and diff3 alone would give
    // "a c a z a" (one "a" too many).
    const result = mergeText("b a a a\n", "a c a a\n", "a a z a\n");
    expect(result.clean).toBe(false);
    expect(result.text).toBe("<<<<<<< yours\na c a a\n=======\na a z a\n>>>>>>> current\n");
  });
  it("marks a paragraph one side removed and the other changed", () => {
    const result = mergeText(
      base,
      base.replace("Connect from home with the client. Ask IT for an account.\n\n", ""),
      base.replace("Ask IT", "Ask the helpdesk"),
    );
    expect(result.clean).toBe(false);
  });
  it("keeps words of other scripts whole", () => {
    const text = "Über den Zugang: bitte früh fragen.\n";
    expect(mergeText(text, text.replace("Über", "Zu"), text.replace("früh", "rechtzeitig"))).toEqual({
      clean: true,
      text: "Zu den Zugang: bitte rechtzeitig fragen.\n",
      conflicts: 0,
    });
  });
  it("merges the words of many paragraphs in time", () => {
    const base = paragraphs(12_000);
    const yours = base.map((line, index) => (index % 40 === 0 ? line.replace("some", "many") : line));
    const current = base.map((line, index) => (index % 40 === 0 ? line.replace("in it", "in there") : line));
    let result = mergeText("", "", "");
    const ms = timed(() => (result = mergeText(base.join("\n"), yours.join("\n"), current.join("\n"))));
    expect(result.clean).toBe(true);
    expect(result.text).toContain(
      "Paragraph 0 with many words in there.\n\nParagraph 1 with some words in it.",
    );
    expect(result.text).toContain("Paragraph 11980 with many words in there.");
    expect(ms).toBeLessThan(1500);
  });
  it("merges the words of the longest paragraphs in time", () => {
    // A page as long as a page may be, every paragraph changed by both sides:
    // word merges stop when their work budget is spent (the rest conflicts).
    const paragraph = (index: number) =>
      Array.from({ length: 2_000 }, (_, word) => `w${index}x${word}`).join(" ");
    const base = Array.from({ length: 30 }, (_, index) => paragraph(index)).join("\n\n");
    const yours = base.replace(/x10 /g, "x10a ");
    const current = base.replace(/x1990 /g, "x1990b ");
    expect(base.length).toBeGreaterThan(450_000);
    let result = mergeText("", "", "");
    expect(timed(() => (result = mergeText(base, yours, current)))).toBeLessThan(1500);
    expect(result.text).toContain("w0x10a w0x11");
    expect(result.text).toContain("w0x1990b w0x1991");
  });
});

describe("word diffs", () => {
  it("marks the changed words of an edited line", () => {
    const lines = diffTextLines("Ask IT for an account.\n", "Ask the helpdesk for an account.\n", {
      words: true,
    });
    expect(lines).toEqual([
      {
        kind: "removed",
        text: "Ask IT for an account.",
        parts: [
          { text: "Ask ", changed: false },
          { text: "IT", changed: true },
          { text: " for an account.", changed: false },
        ],
      },
      {
        kind: "added",
        text: "Ask the helpdesk for an account.",
        parts: [
          { text: "Ask ", changed: false },
          { text: "the helpdesk", changed: true },
          { text: " for an account.", changed: false },
        ],
      },
    ]);
  });
  it("leaves replaced lines whole", () => {
    const lines = diffTextLines("One thing.\n", "Another story!\n", { words: true });
    expect(lines.map((line) => line.parts)).toEqual([undefined, undefined]);
  });
  it("marks changed words with long runs of spaces in time", () => {
    const spaces = " ".repeat(60_000);
    let lines = diffTextLines("", "");
    const ms = timed(() => (lines = diffTextLines("Keep a\n", `Keep b${spaces}c\n`, { words: true })));
    expect(ms).toBeLessThan(500);
    expect(lines[1]!.parts).toEqual([
      { text: "Keep ", changed: false },
      { text: `b${spaces}c`, changed: true },
    ]);
  });
  it("marks words only when asked", () => {
    expect(diffTextLines("a b\n", "a c\n").every((line) => line.parts === undefined)).toBe(true);
  });
});

/** Milliseconds a call takes. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

/** A page of `count` paragraphs, each followed by a blank line, as Markdown is. */
function paragraphs(count: number, word = "Paragraph"): string[] {
  return Array.from({ length: count }, (_, index) => [`${word} ${index} with some words in it.`, ""]).flat();
}

describe("merging large pages", () => {
  it("keeps the blank line after a kept paragraph", () => {
    const base = "One\n\nTwo\n\nThree\n";
    expect(mergeText(base, "One\n\nThree\n", "One changed\n\nTwo\n\nThree\n")).toEqual({
      clean: true,
      text: "One changed\n\nThree\n",
      conflicts: 0,
    });
  });

  it("merges a page of many blank lines in time", () => {
    const base = paragraphs(12_000);
    const yours = [...base];
    yours[20] = "Changed by you.";
    const current = [...base];
    current[base.length - 20] = "Changed meanwhile.";
    let result = mergeText("", "", "");
    const ms = timed(() => {
      result = mergeText(base.join("\n"), yours.join("\n"), current.join("\n"));
    });
    expect(base.join("\n").length).toBeGreaterThan(450_000);
    expect(result.clean).toBe(true);
    expect(result.text).toContain("Changed by you.");
    expect(result.text).toContain("Changed meanwhile.");
    expect(ms).toBeLessThan(1500);
  });

  it("diffs rewritten pages in time", () => {
    const before = paragraphs(11_000, "Old").join("\n");
    const after = paragraphs(11_000, "New").join("\n");
    // Too many changes for an exact diff: every line from the first to the last change counts.
    expect(
      timed(() => expect(lineStats(before, after)).toEqual({ added: 21_999, removed: 21_999 })),
    ).toBeLessThan(1500);
    expect(timed(() => expect(diffTextLines(before, after)).toHaveLength(43_998))).toBeLessThan(1500);
    const merge = timed(() =>
      expect(mergeText(before, after, before.replace("Old 5 ", "Changed 5 ")).clean).toBe(false),
    );
    expect(merge).toBeLessThan(1500);
  });

  it("diffs pages without common lines in time", () => {
    const before = Array.from({ length: 70_000 }, (_, index) => `a${index}`).join("\n");
    const after = Array.from({ length: 70_000 }, (_, index) => `b${index}`).join("\n");
    expect(
      timed(() => expect(lineStats(before, after)).toEqual({ added: 70_000, removed: 70_000 })),
    ).toBeLessThan(1500);
    expect(
      timed(() => expect(diffTextLines(before, after, { words: true })).toHaveLength(140_000)),
    ).toBeLessThan(1500);
  });

  it("diffs pages of repeated lines in time", () => {
    const lines = (mark: string, shift: number) =>
      Array.from({ length: 250_000 }, (_, index) => (index % 500 === shift ? mark : "")).join("\n");
    const [base, yours, current] = [lines("x", 0), lines("y", 250), lines("z", 125)];
    expect(timed(() => lineStats(base, yours))).toBeLessThan(1500);
    expect(timed(() => mergeText(base, yours, current))).toBeLessThan(1500);
  });
});

describe("edits", () => {
  it("refuses edits that make the page too long", () => {
    const page = `---\ntitle: A\n---\n\n${"a ".repeat(50_000)}\n`;
    const result = applyEdits(page, [{ oldText: "a", newText: "b".repeat(20), replaceAll: true }]);
    expect(result).toEqual({
      ok: false,
      index: 0,
      message: "Edit 1: a page may have at most 500000 characters",
    });
  });

  it("limits how many places one call replaces", () => {
    // Without the limit, the second edit would build a string longer than V8 allows and end the process.
    const page = `---\ntitle: A\n---\n\n${"a".repeat(490_000)}\n`;
    const result = applyEdits(page, [
      { oldText: "a", newText: "b".repeat(1000), replaceAll: true },
      { oldText: "b", newText: "c", replaceAll: true },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("more than 100000 places");
  });

  it("finds text in linear time", () => {
    // indexOf takes about half a second for each search of these.
    const one = `${"a".repeat(5000)}b${"a".repeat(5000)}`;
    const other = `${"a".repeat(5000)}c${"a".repeat(5000)}`;
    const edits = Array.from({ length: 100 }, (_, index) =>
      index % 2 === 0 ? { oldText: one, newText: other } : { oldText: other, newText: one },
    );
    let result: EditResult | undefined;
    expect(timed(() => (result = applyEdits(`${"a".repeat(470_000)}${one}`, edits)))).toBeLessThan(1500);
    expect(result?.ok).toBe(true);
  });
});
