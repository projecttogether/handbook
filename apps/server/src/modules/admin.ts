import { Hono } from "hono";
import { count, desc } from "drizzle-orm";
import { tagRenameSchema } from "@handbook/shared/api/pages";
import { auditListQuerySchema, peopleQuerySchema, personUpdateSchema } from "@handbook/shared/api/users";
import { getDb } from "../db/client";
import { auditLog } from "../db/schema";
import type { AppEnv } from "../http/env";
import { idParam, jsonBody, queryOf, requireAdmin } from "../http/middleware";
import { listPeople, renameTag, updatePerson } from "../admin/service";
import { removePerson } from "../admin/remove";
import { isoRequired } from "./util";

const router = new Hono<AppEnv>();

router.get("/admin/people", async (c) => {
  requireAdmin(c);
  const query = queryOf(c, peopleQuerySchema);
  return c.json({ items: await listPeople(getDb(), query.q) });
});

router.patch("/admin/people/:id", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, personUpdateSchema);
  return c.json(await updatePerson(getDb(), actor, idParam(c), input));
});

router.delete("/admin/people/:id", async (c) => {
  const actor = requireAdmin(c);
  await removePerson(getDb(), actor, idParam(c));
  return c.body(null, 204);
});

router.post("/admin/tags/rename", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, tagRenameSchema);
  return c.json(await renameTag(getDb(), actor, input));
});

router.get("/admin/audit", async (c) => {
  requireAdmin(c);
  const query = queryOf(c, auditListQuerySchema);
  const [rows, [total]] = await Promise.all([
    getDb().select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(query.limit).offset(query.offset),
    getDb().select({ value: count() }).from(auditLog),
  ]);
  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      createdAt: isoRequired(row.createdAt),
      actorEmail: row.actorEmail,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      summary: row.summary,
    })),
    total: total?.value ?? 0,
  });
});

export default router;
