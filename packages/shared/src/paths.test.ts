import { describe, expect, it } from "vitest";
import { ancestorPaths, isValidPath, resolveLink, slugify } from "./paths";

describe("paths", () => {
  it("makes slugs", () => {
    expect(slugify("Laptop & VPN (Mac)")).toBe("laptop-vpn-mac");
    expect(slugify("Größe für Übersicht")).toBe("groesse-fuer-uebersicht");
    expect(slugify("!!!")).toBe("page");
  });

  it("checks paths", () => {
    expect(isValidPath("a/b-c/d1")).toBe(true);
    expect(isValidPath("a//b")).toBe(false);
    expect(isValidPath("A")).toBe(false);
  });

  it("lists the ancestors of a path, top first", () => {
    expect(ancestorPaths("a/b/c")).toEqual(["a", "a/b"]);
    expect(ancestorPaths("a")).toEqual([]);
  });

  it("resolves links like files", () => {
    const from = { space: "it", path: "onboarding/laptop" };
    expect(resolveLink("vpn", from)).toEqual({
      kind: "page",
      space: "it",
      path: "onboarding/vpn",
      anchor: null,
    });
    expect(resolveLink("../policies/ai-policy.md#data", from)).toEqual({
      kind: "page",
      space: "it",
      path: "policies/ai-policy",
      anchor: "data",
    });
    expect(resolveLink("./setup/index.md", from)).toMatchObject({ path: "onboarding/setup" });
    expect(resolveLink("/s/hr/leave", from)).toEqual({
      kind: "page",
      space: "hr",
      path: "leave",
      anchor: null,
    });
    expect(resolveLink("../../../x", from)).toEqual({ kind: "invalid" });
    expect(resolveLink("https://example.org", from).kind).toBe("external");
    expect(resolveLink("#top", from)).toEqual({ kind: "anchor", anchor: "top" });
    expect(resolveLink("/files/1/a.png", from).kind).toBe("file");
  });
});
