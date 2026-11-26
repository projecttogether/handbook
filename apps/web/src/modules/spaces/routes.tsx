import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { appRoute } from "@/routes/app";
import { focusRoute } from "@/routes/focus";
import { NewPagePage } from "./new-page-page";
import { SettingsPage } from "./settings-page";
import { SpacePage } from "./space-page";
import { TrashPage } from "./trash-page";

/**
 * Space pages. Pages of a space live at /s/$space/<path>; the space's own
 * screens use /s/$space/-/…, which no page path can start with.
 */
const spaceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$space",
  component: function SpaceRoute() {
    const { space } = spaceRoute.useParams();
    return <SpacePage key={space} space={space} />;
  },
});

const newPageRoute = createRoute({
  getParentRoute: () => focusRoute,
  path: "/s/$space/-/new",
  validateSearch: z.object({
    parent: z.string().max(400).optional().catch(undefined),
    changeSet: z
      .union([z.literal("new"), z.coerce.number().int().min(1)])
      .optional()
      .catch(undefined),
  }),
  component: function NewPageRoute() {
    const { space } = newPageRoute.useParams();
    const { parent, changeSet } = newPageRoute.useSearch();
    return (
      <NewPagePage
        key={`${space}-${parent ?? ""}-${String(changeSet)}`}
        space={space}
        parent={parent}
        changeSet={changeSet}
      />
    );
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$space/-/settings",
  component: function SettingsRoute() {
    const { space } = settingsRoute.useParams();
    return <SettingsPage key={space} space={space} />;
  },
});

const trashRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$space/-/trash",
  component: function TrashRoute() {
    const { space } = trashRoute.useParams();
    return <TrashPage key={space} space={space} />;
  },
});

export const routes: AnyRoute[] = [spaceRoute, settingsRoute, trashRoute];
export const focusRoutes: AnyRoute[] = [newPageRoute];
