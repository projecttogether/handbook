import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { appRoute } from "@/routes/app";
import { HomePage } from "./home-page";

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: HomePage,
});

/** Routes of this module inside the signed-in app (children of appRoute). */
export const routes: AnyRoute[] = [homeRoute];
