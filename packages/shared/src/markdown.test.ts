import { describe, expect, it } from "vitest";
import { markdownProblem } from "./markdown";

/** Milliseconds a call takes. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

/** Ordinary page content: paragraphs with links and emphasis, lists, quotes, tables and code. */
function ordinaryPage(characters: number): string {
  const sections: string[] = [];
  for (let index = 0; sections.join("").length < characters; index += 1) {
    sections.push(
      `## Section ${index}\n\n` +
        `Read the **laptop guide** and the [VPN page](../vpn-${index}) before you start. ` +
        `Ask in \`#it-help\` when *anything* is unclear; the team answers within a day.\n\n` +
        (index % 3 === 0 ? `- First step\n- Second step with a [link](../steps)\n  - A detail\n\n` : "") +
        (index % 5 === 0 ? `> [!NOTE]\n> Keep your password to yourself.\n\n` : "") +
        (index % 7 === 0 ? `| Tool | Owner |\n| - | - |\n| VPN | it@example.org |\n\n` : "") +
        (index % 4 === 0 ? "```sh\nsudo apt install *\n```\n\n" : ""),
    );
  }
  return sections.join("");
}

describe("Markdown the parser can handle", () => {
  it("accepts ordinary pages", () => {
    expect(markdownProblem(ordinaryPage(5_000))).toBeNull();
    // Long and dense: a heading every 300 characters, many lists, quotes and tables.
    expect(markdownProblem(ordinaryPage(200_000))).toBeNull();
    const prose = "Read the **laptop guide** and the [VPN page](../vpn) before you start, then ask *us*.\n\n";
    expect(markdownProblem(prose.repeat(5500))).toBeNull();
  });

  it("accepts long tables, lists and code blocks", () => {
    const table = `| Name | Owner | Link |\n| - | - | - |\n${"| **Laptop** | it@example.org | [guide](../laptop) |\n".repeat(3000)}`;
    expect(markdownProblem(table)).toBeNull();
    expect(markdownProblem("- [Page](../page) with **bold** text\n".repeat(3000))).toBeNull();
    expect(markdownProblem(`1. First\n${"2. Next *step*\n".repeat(3000)}`)).toBeNull();
    expect(markdownProblem(`\`\`\`ts\n${"const a = b * c[0] < d;\n".repeat(5000)}\`\`\`\n`)).toBeNull();
  });

  it("names the line", () => {
    expect(markdownProblem(`Text\n\n${"> ".repeat(17)}deep\n`)).toBe(
      "Line 3: lists, quotes and footnotes are nested more than 16 levels deep",
    );
    expect(markdownProblem(`${"> ".repeat(17)}deep\n`, 5)).toContain("Line 5:");
  });
});

describe("Markdown the parser cannot handle", () => {
  // Each takes the parser seconds to minutes, or runs it out of stack.
  const cases: [string, string, string][] = [
    ["emphasis", "*a**".repeat(40_000), "more than 1000 *, _ and ~"],
    ["nested quotes", `${">".repeat(20_000)} a`, "nested more than 16 levels"],
    ["nested lists", `${"- ".repeat(5000)}a`, "nested more than 16 levels"],
    ["nested footnotes", `${"[^a]: ".repeat(5000)}a`, "nested more than 16 levels"],
    ["label ends", "]".repeat(100_000), "too long and complex"],
    ["HTML comment openers", "a <!--".repeat(30_000), "more than 20000 characters"],
    ["underlined headings", "a\n=\n\n".repeat(50_000), "The page is too long and complex"],
    ["lazy lines", `- a\n${"b\n".repeat(100_000)}`, "too long and complex"],
    ["quote ends", "> a\n\n".repeat(50_000), "The page is too long and complex"],
    ["short lines", "x\n".repeat(240_000), "too long and complex"],
    ["long paragraph", "word ".repeat(10_000), "more than 20000 characters"],
  ];
  it.each(cases)("refuses %s in time", (_name, text, message) => {
    let problem: string | null = null;
    expect(timed(() => (problem = markdownProblem(text)))).toBeLessThan(1500);
    expect(problem).toContain(message);
  });
});
