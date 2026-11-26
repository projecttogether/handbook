import { describe, expect, it } from "vitest";
import { insertBlock, pageLinkMarkdown, prefixLines, wrap } from "./toolbar";

describe("toolbar edits", () => {
  it("wraps the selection or a placeholder", () => {
    expect(wrap("say hi", { from: 4, to: 6 }, "**", "**", "bold")).toEqual({
      from: 4,
      to: 6,
      insert: "**hi**",
      select: { from: 6, to: 8 },
    });
    expect(wrap("", { from: 0, to: 0 }, "_", "_", "text").insert).toBe("_text_");
  });

  it("prefixes and unprefixes lines", () => {
    const text = "one\ntwo\nthree";
    const listed = prefixLines(text, { from: 0, to: 7 }, "- ");
    expect(listed.insert).toBe("- one\n- two");
    expect(prefixLines("- one\n- two", { from: 0, to: 11 }, "- ").insert).toBe("one\ntwo");
    expect(prefixLines("- one", { from: 2, to: 2 }, "## ").insert).toBe("## one");
  });

  it("inserts blocks on their own lines", () => {
    const edit = insertBlock("text", { from: 4, to: 4 }, "> [!NOTE]\n> Text", "Text");
    expect(edit.insert).toBe("\n\n> [!NOTE]\n> Text");
    expect("text".slice(0, 4) + edit.insert).toBe("text\n\n> [!NOTE]\n> Text");
    expect(edit.select).toEqual({ from: 4 + 2 + 12, to: 4 + 2 + 16 });
    expect(insertBlock("", { from: 0, to: 0 }, "x").insert).toBe("x");
  });

  it("links pages by absolute path", () => {
    expect(pageLinkMarkdown("VPN [old]", "it", "network/vpn")).toBe("[VPN old](/s/it/network/vpn)");
  });
});
