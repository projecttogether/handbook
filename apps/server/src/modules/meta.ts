import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { About, AuthConfig, Me } from "@handbook/shared/api/users";
import { spaceRoleSchema } from "@handbook/shared/roles";
import { config } from "../config";
import { getDb } from "../db/client";
import { spaceMembers, spaces } from "../db/schema";
import type { AppEnv } from "../http/env";
import { requireAdmin, requireUser } from "../http/middleware";

const router = new Hono<AppEnv>();

router.get("/auth-config", (c) => {
  const body: AuthConfig = { appName: config().APP_NAME, providerName: config().OIDC_PROVIDER_NAME };
  return c.json(body);
});

/** The version that runs (the commit of the image), for the About card of admins. */
router.get("/about", (c) => {
  requireAdmin(c);
  const body: About = { version: config().APP_VERSION ?? null };
  return c.json(body);
});

router.get("/me", async (c) => {
  const principal = requireUser(c);
  const memberships = await getDb()
    .select({ slug: spaces.slug, role: spaceMembers.role })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(eq(spaceMembers.userId, principal.id));
  const body: Me = {
    id: principal.id,
    email: principal.email,
    name: principal.name || principal.email,
    image: principal.image,
    isAdmin: principal.isAdmin,
    spaces: memberships.flatMap((row) => {
      const role = spaceRoleSchema.safeParse(row.role);
      return role.success ? [{ slug: row.slug, role: role.data }] : [];
    }),
  };
  return c.json(body);
});

export default router;
