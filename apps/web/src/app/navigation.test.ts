import { describe, expect, it } from "vitest";
import { breadcrumbsFor, NAVIGATION, placeOf } from "./navigation";

const items = [
  { label: "Overview", href: "/" },
  { label: "Change sets", href: "/changes" },
  { label: "Tags", href: "/tags" },
  { label: "IT and devices", href: "/s/it" },
  { label: "Spaces", href: "/admin/spaces" },
];
const labels = {
  search: "Search",
  settings: "Settings and agents",
  spaceScreens: { settings: "Settings", trash: "Trash" },
  history: "History",
  revision: (number: number) => `Revision ${number}`,
};
const page = {
  id: "0b5c6a7e-0000-4000-8000-000000000001",
  space: "it",
  spaceName: "IT and devices",
  path: "network/vpn/setup",
  title: "Set up the VPN",
  breadcrumbs: [
    { id: "0b5c6a7e-0000-4000-8000-000000000002", space: "it", path: "network", title: "Network" },
    { id: "0b5c6a7e-0000-4000-8000-000000000003", space: "it", path: "network/vpn", title: "VPN" },
  ],
};
const crumbs = (pathname: string, data: Partial<Parameters<typeof breadcrumbsFor>[1]> = {}) =>
  breadcrumbsFor(pathname, { items, labels, ...data });

describe("NAVIGATION", () => {
  it("gives each main page its own letter, the start page o, and admin pages none", () => {
    const shortcuts = NAVIGATION.flatMap((group) => group.items).flatMap((item) =>
      item.shortcut ? [item.shortcut] : [],
    );
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    expect(NAVIGATION[0]!.items.find((item) => item.to === "/")?.shortcut).toBe("o");
    for (const group of NAVIGATION.filter((group) => group.adminOnly)) {
      expect(group.items.every((item) => !item.shortcut)).toBe(true);
    }
  });
});

describe("placeOf", () => {
  it("tells a space, its own screens, its pages and a page's history apart", () => {
    expect(placeOf("/s/it")).toEqual({ kind: "space", space: "it" });
    expect(placeOf("/s/it/")).toEqual({ kind: "space", space: "it" });
    expect(placeOf("/s/it/-/settings")).toEqual({ kind: "space", space: "it", screen: "settings" });
    expect(placeOf("/s/it/network/vpn")).toEqual({ kind: "page", space: "it", path: "network/vpn" });
    expect(placeOf(`/pages/${page.id}/history`)).toEqual({ kind: "history", pageId: page.id });
    expect(placeOf(`/pages/${page.id}/history/3`)).toEqual({
      kind: "history",
      pageId: page.id,
      revision: 3,
    });
    expect(placeOf("/search")).toBeNull();
    expect(placeOf("/settings")).toBeNull();
  });
});

describe("breadcrumbsFor", () => {
  it("names the sidebar page itself", () => {
    expect(crumbs("/")).toEqual([{ label: "Overview" }]);
    expect(crumbs("/changes")).toEqual([{ label: "Change sets" }]);
    expect(crumbs("/admin/spaces")).toEqual([{ label: "Spaces" }]);
  });

  it("leads back from a change set by its number and from a tag", () => {
    expect(crumbs("/changes/12")).toEqual([{ label: "Change sets", href: "/changes" }, { label: "#12" }]);
    expect(crumbs("/tags/on%20call")).toEqual([{ label: "Tags", href: "/tags" }, { label: "on call" }]);
  });

  it("names the pages outside the sidebar", () => {
    expect(crumbs("/search")).toEqual([{ label: "Search" }]);
    expect(crumbs("/settings")).toEqual([{ label: "Settings and agents" }]);
    expect(crumbs("/somewhere")).toEqual([]);
  });

  it("names a space and its own screens", () => {
    expect(crumbs("/s/it")).toEqual([{ label: "IT and devices" }]);
    expect(crumbs("/s/it/-/trash")).toEqual([{ label: "IT and devices", href: "/s/it" }, { label: "Trash" }]);
    // An archived space is not in the sidebar: its name comes from the space.
    expect(crumbs("/s/old/-/settings", { space: { slug: "old", name: "Old wiki" } })).toEqual([
      { label: "Old wiki", href: "/s/old" },
      { label: "Settings" },
    ]);
    expect(crumbs("/s/unknown")).toEqual([]);
  });

  it("leads from the space through the pages above to the page", () => {
    expect(crumbs("/s/it/network/vpn/setup", { page })).toEqual([
      { label: "IT and devices", href: "/s/it" },
      { label: "Network", href: "/s/it/network" },
      { label: "VPN", href: "/s/it/network/vpn" },
      { label: "Set up the VPN" },
    ]);
    // While the page loads: its space.
    expect(crumbs("/s/it/network/vpn/setup")).toEqual([{ label: "IT and devices", href: "/s/it" }]);
  });

  it("leads to a page's history and its revisions", () => {
    expect(crumbs(`/pages/${page.id}/history`, { page }).slice(-2)).toEqual([
      { label: "Set up the VPN", href: "/s/it/network/vpn/setup" },
      { label: "History" },
    ]);
    expect(crumbs(`/pages/${page.id}/history/3`, { page }).slice(-2)).toEqual([
      { label: "History", href: `/pages/${page.id}/history` },
      { label: "Revision 3" },
    ]);
    expect(crumbs(`/pages/${page.id}/history`)).toEqual([]);
  });
});
