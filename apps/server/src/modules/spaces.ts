import { Hono } from "hono";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import {
  spaceCreateSchema,
  spaceListQuerySchema,
  spaceMemberPutSchema,
  spaceUpdateSchema,
} from "@handbook/shared/api/spaces";
import { getDb } from "../db/client";
import { pages, users } from "../db/schema";
import type { AppEnv } from "../http/env";
import { forbidden } from "../http/errors";
import { idParam, jsonBody, queryOf, requireAdmin, requirePrincipal, requireUser } from "../http/middleware";
import { getSpace, spaceContext } from "../spaces/access";
import { spaceVisibility } from "../spaces/visibility";
import {
  createSpace,
  listMembers,
  listSpaces,
  putMember,
  removeMember,
  setArchived,
  spaceView,
  updateSpace,
} from "../spaces/service";
import { actorOf, iso, pageSummary, pageSummaryColumns } from "../pages/views";
import { exportSpace } from "../exports/export";

const router = new Hono<AppEnv>();

router.get("/spaces", async (c) => {
  const principal = requirePrincipal(c);
  const query = queryOf(c, spaceListQuerySchema);
  return c.json({ items: await listSpaces(getDb(), principal, query.archived) });
});

router.post("/spaces", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, spaceCreateSchema);
  const space = await createSpace(getDb(), actor, input);
  return c.json(await spaceView(getDb(), actor, await spaceContext(getDb(), actor, space)), 201);
});

router.get("/spaces/:space", async (c) => {
  const principal = requirePrincipal(c);
  const context = await spaceContext(getDb(), principal, c.req.param("space"));
  return c.json(await spaceView(getDb(), principal, context));
});

router.patch("/spaces/:space", async (c) => {
  const actor = requireUser(c);
  const context = await spaceContext(getDb(), actor, c.req.param("space"));
  const input = await jsonBody(c, spaceUpdateSchema);
  const space = await updateSpace(getDb(), actor, context, input);
  return c.json(await spaceView(getDb(), actor, await spaceContext(getDb(), actor, space)));
});

for (const [action, archived] of [
  ["archive", true],
  ["unarchive", false],
] as const) {
  router.post(`/spaces/:space/${action}`, async (c) => {
    const actor = requireAdmin(c);
    const space = await setArchived(getDb(), actor, await getSpace(getDb(), c.req.param("space")), archived);
    return c.json(await spaceView(getDb(), actor, await spaceContext(getDb(), actor, space)));
  });
}

router.get("/spaces/:space/members", async (c) => {
  requireUser(c);
  const space = await getSpace(getDb(), c.req.param("space"));
  return c.json({ items: await listMembers(getDb(), space.id) });
});

router.put("/spaces/:space/members", async (c) => {
  const actor = requireUser(c);
  const context = await spaceContext(getDb(), actor, c.req.param("space"));
  await putMember(getDb(), actor, context, await jsonBody(c, spaceMemberPutSchema));
  return c.json({ items: await listMembers(getDb(), context.space.id) });
});

router.delete("/spaces/:space/members/:userId", async (c) => {
  const actor = requireUser(c);
  const context = await spaceContext(getDb(), actor, c.req.param("space"));
  await removeMember(getDb(), actor, context, idParam(c, "userId"));
  return c.json({ items: await listMembers(getDb(), context.space.id) });
});

router.get("/spaces/:space/tree", async (c) => {
  const principal = requirePrincipal(c);
  const context = await spaceContext(getDb(), principal, c.req.param("space"));
  const { space } = context;
  const rows = await getDb()
    .select(pageSummaryColumns)
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), spaceVisibility(context).livePages()))
    .orderBy(asc(pages.position), asc(pages.title));
  return c.json({ items: rows.map((row) => pageSummary(row, space.slug)) });
});

router.get("/spaces/:space/trash", async (c) => {
  const principal = requirePrincipal(c);
  const context = await spaceContext(getDb(), principal, c.req.param("space"));
  if (!spaceVisibility(context).seesTrash(context.space.id)) {
    throw forbidden("Only editors of this space see its trash");
  }
  const rows = await getDb()
    .select({
      page: pageSummaryColumns,
      deletedAt: pages.deletedAt,
      deletedBy: { id: users.id, name: users.name, email: users.email },
    })
    .from(pages)
    .leftJoin(users, eq(users.id, pages.deletedById))
    .where(and(eq(pages.spaceId, context.space.id), isNotNull(pages.deletedAt)))
    .orderBy(desc(pages.deletedAt));
  return c.json({
    items: rows.map((row) => ({
      ...pageSummary(row.page, context.space.slug),
      deletedAt: iso(row.deletedAt!),
      deletedBy: actorOf(row.deletedBy),
    })),
  });
});

router.get("/spaces/:space/export", async (c) => {
  const principal = requirePrincipal(c);
  const context = await spaceContext(getDb(), principal, c.req.param("space"));
  const zip = await exportSpace(getDb(), context);
  c.header("content-type", "application/zip");
  c.header("content-disposition", `attachment; filename="${context.space.slug}.zip"`);
  c.header("cache-control", "private, no-store");
  return c.body(zip);
});

export default router;
