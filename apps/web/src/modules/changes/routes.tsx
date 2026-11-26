import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { appRoute } from "@/routes/app";
import { ChangeSetPage } from "./change-set-page";
import { ChangeSetsPage } from "./change-sets-page";

const STATUSES = ["active", "open", "in_review", "merged", "closed", "all"] as const;

const listRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/changes",
  validateSearch: z.object({
    status: z.enum(STATUSES).optional().catch(undefined),
    space: z.string().max(40).optional().catch(undefined),
    mine: z.boolean().optional().catch(undefined),
  }),
  component: function ChangeSetsRoute() {
    const search = listRoute.useSearch();
    const navigate = listRoute.useNavigate();
    return (
      <ChangeSetsPage
        filters={{ status: search.status ?? "active", space: search.space, mine: search.mine }}
        onFilters={(filters) =>
          void navigate({
            search: {
              status: filters.status === "active" ? undefined : filters.status,
              space: filters.space,
              mine: filters.mine || undefined,
            },
            replace: true,
          })
        }
      />
    );
  },
});

const detailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/changes/$number",
  params: {
    parse: (params) => ({ number: z.coerce.number().int().min(1).max(2_147_483_647).parse(params.number) }),
    stringify: (params) => ({ number: String(params.number) }),
  },
  component: function ChangeSetRoute() {
    const { number } = detailRoute.useParams();
    return <ChangeSetPage key={number} number={number} />;
  },
});

/** Routes of this module inside the signed-in app (children of appRoute). */
export const routes: AnyRoute[] = [listRoute, detailRoute];
