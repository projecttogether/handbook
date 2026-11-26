import type { Page } from "@handbook/shared/api/pages";
import { pageUrl } from "@handbook/shared/paths";
import { defineMessages } from "@/i18n";

export const navMessages = defineMessages({
  en: {
    browse: "Browse",
    overview: "Overview",
    changes: "Change sets",
    tags: "Tags",
    spaces: "Spaces",
    admin: "Administration",
    manageSpaces: "Spaces",
    people: "People",
    serviceTokens: "Service tokens",
    audit: "Audit log",
  },
});

export type NavKey = keyof typeof navMessages.en;
/** `shortcut`: "G then this letter" opens the page (main pages only, each letter once). */
export type NavItem = { key: NavKey; to: string; shortcut?: string };
export type NavGroup = { key: NavKey; items: NavItem[]; adminOnly: boolean };

/**
 * The sidebar's fixed groups, as text; the layout adds the spaces after
 * the first. The search sits above them in the frame. The server checks
 * access too.
 */
export const NAVIGATION: NavGroup[] = [
  {
    key: "browse",
    adminOnly: false,
    items: [
      { key: "overview", to: "/", shortcut: "o" },
      { key: "changes", to: "/changes", shortcut: "c" },
      { key: "tags", to: "/tags", shortcut: "t" },
    ],
  },
  {
    key: "admin",
    adminOnly: true,
    items: [
      { key: "manageSpaces", to: "/admin/spaces" },
      { key: "people", to: "/admin/people" },
      { key: "serviceTokens", to: "/admin/service-tokens" },
      { key: "audit", to: "/admin/audit" },
    ],
  },
];

/** What a path shows that needs data for its breadcrumbs: a space, one of its pages, or a page's history. */
export type Place =
  | { kind: "space"; space: string; screen?: string }
  | { kind: "page"; space: string; path: string }
  | { kind: "history"; pageId: string; revision?: number };

export function placeOf(pathname: string): Place | null {
  const history = /^\/pages\/([^/]+)\/history(?:\/(\d+))?\/?$/.exec(pathname);
  if (history) {
    return { kind: "history", pageId: history[1]!, revision: history[2] ? Number(history[2]) : undefined };
  }
  const space = /^\/s\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!space) return null;
  const rest = (space[2] ?? "").replace(/\/+$/, "");
  if (!rest) return { kind: "space", space: space[1]! };
  // The space's own screens use /s/<space>/-/…, which no page path can start with.
  if (rest.startsWith("-/")) return { kind: "space", space: space[1]!, screen: rest.slice(2) };
  return { kind: "page", space: space[1]!, path: rest };
}

export type Crumb = { label: string; href?: string };

export type CrumbLabels = {
  search: string;
  settings: string;
  spaceScreens: Record<string, string>;
  history: string;
  revision: (number: number) => string;
};

type PageTrail = Pick<Page, "id" | "space" | "spaceName" | "path" | "title" | "breadcrumbs">;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Where a page sits: from the sidebar item to the page. A page of a space
 * leads from the space through the pages above it (the frame shows the
 * last steps); a change set appears by its number. `space` and `page` are
 * the data of the current path once loaded.
 */
export function breadcrumbsFor(
  pathname: string,
  context: {
    items: { label: string; href: string }[];
    labels: CrumbLabels;
    space?: { slug: string; name: string };
    page?: PageTrail;
  },
): Crumb[] {
  const { items, labels, page } = context;
  const place = placeOf(pathname);

  if (place?.kind === "page" || place?.kind === "history") {
    const spaceSlug = page?.space ?? (place.kind === "page" ? place.space : undefined);
    const spaceName =
      page?.spaceName ??
      (context.space?.slug === spaceSlug ? context.space?.name : undefined) ??
      items.find((item) => item.href === `/s/${spaceSlug}`)?.label;
    const spaceCrumb = spaceSlug && spaceName ? [{ label: spaceName, href: `/s/${spaceSlug}` }] : [];
    if (!page) return spaceCrumb;
    const trail: Crumb[] = [
      ...spaceCrumb,
      ...page.breadcrumbs.map((crumb) => ({ label: crumb.title, href: pageUrl(crumb.space, crumb.path) })),
    ];
    if (place.kind === "page") return [...trail, { label: page.title }];
    const pageCrumb = { label: page.title, href: pageUrl(page.space, page.path) };
    if (place.revision === undefined) return [...trail, pageCrumb, { label: labels.history }];
    return [
      ...trail,
      pageCrumb,
      { label: labels.history, href: `/pages/${page.id}/history` },
      { label: labels.revision(place.revision) },
    ];
  }

  if (place?.kind === "space") {
    const href = `/s/${place.space}`;
    const name =
      (context.space?.slug === place.space ? context.space.name : undefined) ??
      items.find((item) => item.href === href)?.label;
    if (!name) return [];
    if (!place.screen) return [{ label: name }];
    const screen = labels.spaceScreens[place.screen];
    return screen ? [{ label: name, href }, { label: screen }] : [{ label: name, href }];
  }

  if (pathname === "/search") return [{ label: labels.search }];
  if (pathname === "/settings") return [{ label: labels.settings }];

  const item = items
    .filter((candidate) =>
      candidate.href === "/"
        ? pathname === "/"
        : pathname === candidate.href || pathname.startsWith(`${candidate.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (!item) return [];
  if (pathname === item.href) return [{ label: item.label }];
  const parent = { label: item.label, href: item.href };
  const rest = decoded(pathname.slice(item.href.length + 1).replace(/\/+$/, ""));
  if (item.href === "/changes" && /^\d+$/.test(rest)) return [parent, { label: `#${rest}` }];
  if (item.href === "/tags" && rest) return [parent, { label: rest }];
  return [parent];
}
