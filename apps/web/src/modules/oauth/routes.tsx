import { createRoute, redirect, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { meQuery } from "@/hooks/use-me";
import { ApiError } from "@/lib/api";
import { rootRoute } from "@/routes/root";
import { ConsentPage } from "./consent-page";

/** The consent screen of connected apps, outside the app layout; signed-in people only. */
const consentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/consent",
  validateSearch: z.object({ request: z.string().max(100).catch("") }),
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw redirect({ to: "/sign-in", search: { redirect: location.href } });
      }
      throw error;
    }
  },
  component: function ConsentRoute() {
    const { request } = consentRoute.useSearch();
    return <ConsentPage key={request} requestId={request} />;
  },
});

/** Routes of this module inside the signed-in app (children of appRoute). */
export const routes: AnyRoute[] = [];

/** Routes outside the app layout (children of rootRoute). */
export const rootRoutes: AnyRoute[] = [consentRoute];
