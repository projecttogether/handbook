import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { appRoute, requireAdmin } from "@/routes/app";
import { AdminPeoplePage } from "./people-page";
import { AdminServiceTokensPage } from "./service-tokens-page";
import { AdminSpacesPage } from "./spaces-page";

const spacesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/spaces",
  beforeLoad: requireAdmin(),
  component: AdminSpacesPage,
});

const peopleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/people",
  beforeLoad: requireAdmin(),
  component: AdminPeoplePage,
});

const serviceTokensRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/service-tokens",
  beforeLoad: requireAdmin(),
  component: AdminServiceTokensPage,
});

/** Routes of this module inside the signed-in app (children of appRoute). */
export const routes: AnyRoute[] = [spacesRoute, peopleRoute, serviceTokensRoute];
