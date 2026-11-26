import { useEffect } from "react";
import { createRoute, Outlet } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthConfig } from "@/lib/auth-config";
import { requireSignIn } from "./app";
import { rootRoute } from "./root";

const DEFAULT_APP_NAME = "Handbook";

/** The focused editor: the whole window for writing, without the app's sidebar and header. */
function FocusLayout() {
  const appName = useAuthConfig()?.appName || DEFAULT_APP_NAME;
  useEffect(() => {
    document.title = appName;
  }, [appName]);
  return (
    <TooltipProvider delayDuration={300}>
      <main id="main" className="bg-background min-h-svh">
        <Outlet />
      </main>
    </TooltipProvider>
  );
}

/** Signed-in screens in the focused layout (editing and creating pages). */
export const focusRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "focus",
  beforeLoad: requireSignIn,
  component: FocusLayout,
});
