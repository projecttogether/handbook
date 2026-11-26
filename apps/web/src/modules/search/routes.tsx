import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { appRoute } from "@/routes/app";
import { SearchPage } from "./search-page";
import { TagPage, TagsPage } from "./tags-page";

const text = z.string().trim().max(200).optional().catch(undefined);

const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search",
  validateSearch: z.object({ q: text, space: text, tag: text, type: text }),
  component: function SearchRoute() {
    const params = searchRoute.useSearch();
    const navigate = searchRoute.useNavigate();
    return (
      <SearchPage
        key={params.q ?? ""}
        params={params}
        onChange={(next) =>
          void navigate({
            search: {
              q: next.q || undefined,
              space: next.space || undefined,
              tag: next.tag || undefined,
              type: next.type || undefined,
            },
          })
        }
      />
    );
  },
});

const tagsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tags",
  component: TagsPage,
});

const tagRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tags/$tag",
  component: function TagRoute() {
    const { tag } = tagRoute.useParams();
    return <TagPage key={tag} tag={tag} />;
  },
});

export const routes: AnyRoute[] = [searchRoute, tagsRoute, tagRoute];
