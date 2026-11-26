import type { AnyRoute } from "@tanstack/react-router";
import { routes as admin } from "./admin/routes";
import { routes as audit } from "./audit/routes";
import { routes as changes } from "./changes/routes";
import { routes as home } from "./home/routes";
import { routes as oauth, rootRoutes as oauthRoot } from "./oauth/routes";
import { focusRoutes as pagesFocus, routes as pages } from "./pages/routes";
import { routes as search } from "./search/routes";
import { routes as settings } from "./settings/routes";
import { focusRoutes as spacesFocus, routes as spaces } from "./spaces/routes";

/** Routes of every module inside the signed-in app. Add new modules here. */
export const appRoutes: AnyRoute[] = [
  ...home,
  ...spaces,
  ...pages,
  ...search,
  ...changes,
  ...settings,
  ...admin,
  ...audit,
  ...oauth,
];

/** Routes outside the app layout (children of the root route), e.g. the OAuth consent screen. */
export const rootRoutes: AnyRoute[] = [...oauthRoot];

/** Routes in the focused layout without the app's sidebar (the page editor). */
export const focusRoutes: AnyRoute[] = [...pagesFocus, ...spacesFocus];
