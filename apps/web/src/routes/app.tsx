import { createRoute, notFound, redirect } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { meQuery } from "@/hooks/use-me";
import { AppLayout } from "@/components/layout/app-layout";
import { rootRoute } from "./root";

/**
 * The signed-in application. Every module's routes are children of this
 * route (`getParentRoute: () => appRoute`); it loads the signed-in person
 * first and sends everyone else to the sign-in page.
 */
export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: requireSignIn,
  component: AppLayout,
});

/**
 * Loads the signed-in person; sends everyone else to the sign-in page.
 * Every signed-in layout (the app, the focused editor) starts with it.
 */
export async function requireSignIn({
  context,
  location,
}: {
  context: { queryClient: QueryClient };
  location: { href: string };
}) {
  try {
    await context.queryClient.ensureQueryData(meQuery);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    }
    throw error;
  }
}

/** `beforeLoad` of admin pages: others see "not found" (the server enforces access too). */
export function requireAdmin() {
  return async ({ context }: { context: { queryClient: QueryClient } }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me.isAdmin) throw notFound();
  };
}
