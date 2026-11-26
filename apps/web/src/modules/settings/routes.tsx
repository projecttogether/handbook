import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { appRoute } from "@/routes/app";
import { SettingsPage } from "./settings-page";

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsPage,
});

/** Routes of this module inside the signed-in app (children of appRoute). */
export const routes: AnyRoute[] = [settingsRoute];
