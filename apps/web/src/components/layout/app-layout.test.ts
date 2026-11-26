import { describe, expect, it } from "vitest";
import { sidebarOpenOn } from "./app-layout";

describe("sidebarOpenOn", () => {
  it("hides the sidebar on pages and shows it elsewhere, until the person chooses", () => {
    expect(sidebarOpenOn("/s/it/network/vpn", {})).toBe(false);
    expect(sidebarOpenOn("/s/it", {})).toBe(true);
    expect(sidebarOpenOn("/s/it/-/settings", {})).toBe(true);
    expect(sidebarOpenOn("/", {})).toBe(true);
  });

  it("keeps one choice for pages and one for the rest", () => {
    const preference = { page: true, app: false };
    expect(sidebarOpenOn("/s/it/onboarding", preference)).toBe(true);
    expect(sidebarOpenOn("/search", preference)).toBe(false);
  });
});
