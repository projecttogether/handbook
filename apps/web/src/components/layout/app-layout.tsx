import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SearchResponse } from "@handbook/shared/api/search";
import type { SpaceSummary } from "@handbook/shared/api/spaces";
import { pageUrl } from "@handbook/shared/paths";
import { AppFrame, type FrameLink, type NavGroup, type SearchResult } from "@/components/ui/app-frame";
import { AppIcon, SidebarOrganization } from "@/components/brand";
import { useMe } from "@/hooks/use-me";
import { useTheme } from "@/lib/theme";
import { authClient } from "@/lib/auth-client";
import { useAuthConfig } from "@/lib/auth-config";
import { queryClient } from "@/lib/query";
import { defineMessages, useT } from "@/i18n";
import { breadcrumbsFor, NAVIGATION, navMessages, placeOf } from "@/app/navigation";
import { pageByPathQuery, pageQuery, spaceQuery } from "@/components/page/queries";
import { api } from "@/lib/api";
import { messages as pageMessages } from "@/modules/pages/messages";
import { messages as searchMessages } from "@/modules/search/messages";
import { messages as settingsMessages } from "@/modules/settings/messages";
import { messages as spaceMessages } from "@/modules/spaces/messages";

const messages = defineMessages({
  en: {
    admin: "Admin",
  },
});

/** The spaces in the sidebar; modules that change spaces invalidate ["spaces"]. */
export const spacesQuery = {
  queryKey: ["spaces"] as const,
  queryFn: () => api.get<{ items: SpaceSummary[] }>("/spaces"),
  staleTime: 60_000,
};

const DEFAULT_APP_NAME = "Handbook";

const SIDEBAR_KEY = "handbook.sidebar";
export type SidebarPreference = { page?: boolean; app?: boolean };

/** On pages the sidebar starts hidden, so the text gets the room; elsewhere it starts open. */
export function sidebarOpenOn(pathname: string, preference: SidebarPreference): boolean {
  return placeOf(pathname)?.kind === "page" ? (preference.page ?? false) : (preference.app ?? true);
}

/** Whether the sidebar is open; each person's choice is remembered for pages and for the rest, in this browser. */
function useSidebarOpen(pathname: string): [boolean, (open: boolean) => void] {
  const [preference, setPreference] = useState<SidebarPreference>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(SIDEBAR_KEY) ?? "{}") as SidebarPreference;
    } catch {
      return {};
    }
  });
  const setOpen = (open: boolean) => {
    const next = { ...preference, [placeOf(pathname)?.kind === "page" ? "page" : "app"]: open };
    setPreference(next);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, JSON.stringify(next));
    } catch {
      // Private windows may refuse storage; the choice then lasts until reload.
    }
  };
  return [sidebarOpenOn(pathname, preference), setOpen];
}

/** TanStack Router's link for the frame: every other prop goes on to the <a>. */
// `exact`: otherwise TanStack marks every link the address starts with as the current page
// (breadcrumb parents, the sidebar's sections).
const AppLink: FrameLink = ({ href, ...props }) => (
  <Link to={href} activeOptions={{ exact: true }} {...props} />
);

/** Pages of every space the person may read; the server leaves out what they may not see. */
async function findPages(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const { results } = await api.get<SearchResponse>("/search", { q: query, limit: 8 }, signal);
  return results.map((result) => ({
    href: pageUrl(result.space.slug, result.path, result.anchor),
    title: result.title,
    kind: result.space.name,
  }));
}

/**
 * The data of the current path that its breadcrumbs name: the space, and
 * the page of a page or its history. The pages load the same queries, so
 * this asks for nothing more.
 */
function usePlaceData(pathname: string) {
  const place = placeOf(pathname);
  const spaceSlug = place?.kind === "space" || place?.kind === "page" ? place.space : "";
  const space = useQuery({ ...spaceQuery(spaceSlug), enabled: spaceSlug !== "" }).data;
  const byPath = useQuery({
    ...pageByPathQuery(place?.kind === "page" ? place.space : "", place?.kind === "page" ? place.path : ""),
    enabled: place?.kind === "page",
  }).data;
  const byId = useQuery({
    ...pageQuery(place?.kind === "history" ? place.pageId : ""),
    enabled: place?.kind === "history",
  }).data;
  return { space, page: place?.kind === "page" ? byPath : byId };
}

/** The signed-in application frame: the AppFrame with Handbook's navigation and spaces. */
export function AppLayout() {
  const me = useMe();
  const m = useT(messages);
  const t = useT(navMessages);
  const tPage = useT(pageMessages);
  const tSearch = useT(searchMessages);
  const tSettings = useT(settingsMessages);
  const tSpace = useT(spaceMessages);
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const spaces = useQuery(spacesQuery).data?.items ?? [];
  const place = usePlaceData(pathname);
  const [sidebarOpen, setSidebarOpen] = useSidebarOpen(pathname);
  const { theme, setTheme } = useTheme();
  const appName = useAuthConfig()?.appName || DEFAULT_APP_NAME;
  useEffect(() => {
    document.title = appName;
  }, [appName]);

  const groups: NavGroup[] = NAVIGATION.filter((group) => !group.adminOnly || me.isAdmin).map((group) => ({
    label: t(group.key),
    items: group.items.map((item) => ({ label: t(item.key), href: item.to, shortcut: item.shortcut })),
  }));
  // The spaces follow the first group; they get no shortcuts.
  const spaceGroup: NavGroup = {
    label: t("spaces"),
    items: spaces.map((space) => ({ label: space.name, href: `/s/${space.slug}` })),
  };
  const nav = spaceGroup.items.length > 0 ? [groups[0]!, spaceGroup, ...groups.slice(1)] : groups;

  const breadcrumbs = breadcrumbsFor(pathname, {
    items: nav.flatMap((group) => group.items),
    labels: {
      search: tSearch("title"),
      settings: tSettings("title"),
      spaceScreens: { settings: tSpace("settings"), trash: tSpace("trash") },
      history: tPage("history"),
      revision: (number) => tPage("revision", { number }),
    },
    space: place.space,
    page: place.page,
  });

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    window.location.assign("/sign-in");
  };

  return (
    <AppFrame
      app={{ name: appName, icon: <AppIcon /> }}
      sidebarFooter={<SidebarOrganization />}
      nav={nav}
      pathname={pathname}
      link={AppLink}
      navigate={(href) => void router.navigate({ href })}
      user={{
        name: me.name || me.email,
        email: me.email,
        detail: me.isAdmin ? m("admin") : undefined,
        image: me.image,
      }}
      theme={theme}
      onThemeChange={setTheme}
      settingsHref="/settings"
      onSignOut={() => void signOut()}
      breadcrumbs={breadcrumbs}
      sidebarOpen={sidebarOpen}
      onSidebarOpenChange={setSidebarOpen}
      search={{
        find: findPages,
        // The router's own encoding: it reads query values as JSON, so "123" must stay a string.
        allResultsHref: (q) => router.buildLocation({ to: "/search", search: { q } }).href,
      }}
    >
      <Outlet />
    </AppFrame>
  );
}
