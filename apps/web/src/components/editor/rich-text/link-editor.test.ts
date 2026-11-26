import { describe, expect, it } from "vitest";
import { linkTarget } from "./link-editor";

describe("linkTarget", () => {
  it("keeps addresses and paths as written", () => {
    expect(linkTarget("https://example.org/a")).toBe("https://example.org/a");
    expect(linkTarget("mailto:help@example.org")).toBe("mailto:help@example.org");
    expect(linkTarget("/s/it/vpn")).toBe("/s/it/vpn");
    expect(linkTarget("../laptop")).toBe("../laptop");
    expect(linkTarget("#steps")).toBe("#steps");
  });

  it("adds https:// to a bare domain", () => {
    expect(linkTarget("example.org/help")).toBe("https://example.org/help");
  });

  it("treats words as a page search", () => {
    expect(linkTarget("vpn setup")).toBeNull();
    expect(linkTarget("laptop")).toBeNull();
    expect(linkTarget("")).toBeNull();
  });
});
