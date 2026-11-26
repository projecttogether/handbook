import { beforeAll, describe, expect, it } from "vitest";
import { markdownProblem } from "@handbook/shared/markdown";
import { MAX_PAGE_CHARACTERS } from "@handbook/shared/page";
import { pageLinksOf, parseMarkdown, sectionsOf } from "./analyze";

/** Milliseconds a call takes. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

/** The fastest of a few runs: tests running meanwhile slow down single runs. */
function fastest(run: () => void, runs: number): number {
  return Math.min(...Array.from({ length: runs }, () => timed(run)));
}

/**
 * Milliseconds to parse a page of plain paragraphs of the maximum size on
 * this machine. Slow parses are compared with it rather than with a fixed
 * time, because CI runners are several times slower than a laptop.
 */
let plainPage = 0;
beforeAll(() => {
  const paragraph = "Install the VPN client from the portal and sign in with your work account.\n\n";
  const text = paragraph.repeat(Math.floor(MAX_PAGE_CHARACTERS / paragraph.length));
  expect(markdownProblem(text)).toBeNull();
  plainPage = fastest(() => parseMarkdown(text), 3);
}, 30_000);

const from = { space: "it", path: "onboarding/laptop" };

describe("analyzing page bodies", () => {
  it("leaves callout markers out of section texts", () => {
    expect(sectionsOf("## Setup\n\n> [!NOTE]\n> Keep the charger.\n")).toEqual([
      { position: 0, anchor: "setup", headingPath: ["Setup"], content: "Keep the charger." },
    ]);
  });

  it("splits a code block of many blank lines in time", () => {
    // `^\s*` in the callout pattern took seconds here.
    const body = `## Code\n\n\`\`\`\n${"\n".repeat(60_000)}x\n\`\`\`\n`;
    expect(markdownProblem(body)).toBeNull();
    expect(timed(() => expect(sectionsOf(body)).toHaveLength(1))).toBeLessThan(5 * plainPage);
  });

  it("keeps Markdown the parser cannot handle as plain text", () => {
    // Saving refuses these; a change set item with conflict blocks is not checked.
    const deep = `${">".repeat(20_000)} [a](../vpn)`;
    expect(timed(() => expect(pageLinksOf(deep, from)).toEqual([]))).toBeLessThan(1500);
    const emphasis = "*a**".repeat(40_000);
    expect(timed(() => expect(sectionsOf(emphasis)[0]?.content).toHaveLength(160_000))).toBeLessThan(1500);
  });
});

describe("the limits of markdownProblem", () => {
  // The largest text of each kind the check allows: the parser must still be
  // quick (in production each takes under 0.7 s). The slowest kind, HTML
  // comment openers, takes about five times as long as the plain page; the
  // others take under twice as long.
  const kinds: [string, string][] = [
    ["emphasis", "*a**"],
    ["label ends", "a]"],
    ["HTML comment openers", "a <!--"],
    ["underlined headings", "a\n=\n\n"],
    ["lazy lines", "- a\nb\n"],
    ["quote ends", "> a\n\n"],
    ["nested list items", "- - - - - - - - a\n"],
    ["short lines", "a b\n"],
  ];
  it.each(kinds)(
    "allows only %s that parse in time",
    (_name, unit) => {
      let low = 0;
      let high = 500_000;
      while (high - low > 500) {
        const middle = Math.floor((low + high) / 2);
        if (markdownProblem(unit.repeat(middle / unit.length))) high = middle;
        else low = middle;
      }
      const text = unit.repeat(low / unit.length);
      expect(markdownProblem(text)).toBeNull();
      expect(fastest(() => parseMarkdown(text), 2)).toBeLessThan(10 * plainPage);
    },
    30_000,
  );
});
