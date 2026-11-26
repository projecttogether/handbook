import { Hono, type Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import {
  draftPutSchema,
  lockRenewSchema,
  pageByPathQuerySchema,
  pageCreateSchema,
  pageMoveSchema,
  pageSaveSchema,
  revisionListQuerySchema,
  revisionRestoreSchema,
} from "@handbook/shared/api/pages";
import { joinPath } from "@handbook/shared/paths";
import { getDb, type DbOrTx } from "../db/client";
import { drafts, editLocks, pages } from "../db/schema";
import type { AppEnv } from "../http/env";
import { notFound } from "../http/errors";
import { markFilesUsed } from "../files/storage";
import {
  idParam,
  jsonBody,
  queryOf,
  requirePrincipal,
  requireUser,
  requireWebUser,
} from "../http/middleware";
import type { Principal, UserPrincipal } from "../auth/principal";
import { getSpaceById, requireAbility, spaceContext, type SpaceContext } from "../spaces/access";
import { spaceVisibility } from "../spaces/visibility";
import {
  authorOf,
  createLivePage,
  deleteLivePage,
  findPageByPathOrRedirect,
  lockPage,
  moveLivePage,
  restoreDeletedPage,
  revisionMarkdown,
  saveLivePage,
  type PageRow,
} from "../pages/core";
import { getRevision, iso, listRevisions, pageView } from "../pages/views";
import { acquireLock, checkLockForSave, releaseLock, renewLock, takeOverLock } from "../pages/locks";

const router = new Hono<AppEnv>();

/** A page number in the path (404 for anything else). */
function revisionParam(c: Context<AppEnv>): number {
  const value = c.req.param("number") ?? "";
  if (!/^[1-9]\d{0,8}$/.test(value)) throw notFound("No such revision");
  return Number(value);
}

/** A page and its space context; drafts and the pages below them 404 for readers; deleted pages 404 unless asked for. */
async function loadPage(
  tx: DbOrTx,
  principal: Principal,
  pageId: string,
  options: { deleted?: boolean; lock?: boolean } = {},
): Promise<{ page: PageRow; context: SpaceContext }> {
  const page = options.lock
    ? await lockPage(tx, pageId, { deleted: options.deleted })
    : (await tx.select().from(pages).where(eq(pages.id, pageId)))[0];
  if (!page || (page.deletedAt !== null) !== (options.deleted ?? false)) throw notFound("No such page");
  const context = await spaceContext(tx, principal, await getSpaceById(tx, page.spaceId));
  await spaceVisibility(context).assertPage(tx, page);
  return { page, context };
}

router.get("/spaces/:space/pages/by-path", async (c) => {
  const principal = requirePrincipal(c);
  const { path } = queryOf(c, pageByPathQuerySchema);
  const context = await spaceContext(getDb(), principal, c.req.param("space"));
  const page = await findPageByPathOrRedirect(getDb(), context.space.id, path);
  if (!page) throw notFound("No such page");
  await spaceVisibility(context).assertPage(getDb(), page);
  return c.json(await pageView(getDb(), principal, context, page));
});

router.post("/spaces/:space/pages", async (c) => {
  const actor = requireUser(c);
  const input = await jsonBody(c, pageCreateSchema);
  const context = await spaceContext(getDb(), actor, c.req.param("space"));
  requireAbility(context, "editLive");
  const page = await getDb().transaction((tx) =>
    createLivePage(tx, {
      space: context.space,
      parentPath: input.parentPath,
      slug: input.slug,
      markdown: input.markdown,
      author: authorOf(actor, "web"),
    }),
  );
  return c.json(await pageView(getDb(), actor, context, page), 201);
});

router.get("/pages/:id", async (c) => {
  const principal = requirePrincipal(c);
  const { page, context } = await loadPage(getDb(), principal, idParam(c));
  return c.json(await pageView(getDb(), principal, context, page));
});

/** Saves a page live: lock rules, then the page core (merge or 409 page_changed). */
router.put("/pages/:id", async (c) => {
  const actor = requireUser(c);
  const input = await jsonBody(c, pageSaveSchema);
  const pageId = idParam(c);
  const { page, context } = await getDb().transaction(async (tx) => {
    const loaded = await loadPage(tx, actor, pageId, { lock: true });
    requireAbility(loaded.context, "editLive");
    const holdsLock = await checkLockForSave(tx, pageId, actor.id, input.lockToken);
    const saved = await saveLivePage(tx, {
      space: loaded.context.space,
      page: loaded.page,
      markdown: input.markdown,
      baseRevision: input.baseRevision,
      author: authorOf(actor, "web", { message: input.message ?? null }),
    });
    if (holdsLock && input.lockToken) await releaseLock(tx, pageId, input.lockToken);
    await tx.delete(drafts).where(and(eq(drafts.pageId, pageId), eq(drafts.userId, actor.id)));
    return { page: saved.page, context: loaded.context };
  });
  return c.json(await pageView(getDb(), actor, context, page));
});

router.post("/pages/:id/move", async (c) => {
  const actor = requireUser(c);
  const input = await jsonBody(c, pageMoveSchema);
  const pageId = idParam(c);
  const { page, context } = await getDb().transaction(async (tx) => {
    const loaded = await loadPage(tx, actor, pageId, { lock: true });
    requireAbility(loaded.context, "editLive");
    const moved = await moveLivePage(tx, {
      space: loaded.context.space,
      page: loaded.page,
      newPath: joinPath(input.parentPath, input.slug),
      position: input.position,
      author: authorOf(actor, "web"),
    });
    return { page: moved, context: loaded.context };
  });
  return c.json(await pageView(getDb(), actor, context, page));
});

router.delete("/pages/:id", async (c) => {
  const actor = requireUser(c);
  const pageId = idParam(c);
  await getDb().transaction(async (tx) => {
    const loaded = await loadPage(tx, actor, pageId, { lock: true });
    requireAbility(loaded.context, "editLive");
    await deleteLivePage(tx, {
      space: loaded.context.space,
      page: loaded.page,
      author: authorOf(actor, "web"),
    });
    await tx.delete(editLocks).where(eq(editLocks.pageId, pageId));
  });
  return c.body(null, 204);
});

router.post("/pages/:id/restore", async (c) => {
  const actor = requireUser(c);
  const pageId = idParam(c);
  const { page, context } = await getDb().transaction(async (tx) => {
    const loaded = await loadPage(tx, actor, pageId, { lock: true, deleted: true });
    requireAbility(loaded.context, "editLive");
    const restored = await restoreDeletedPage(tx, {
      space: loaded.context.space,
      page: loaded.page,
      author: authorOf(actor, "restore"),
    });
    return { page: restored, context: loaded.context };
  });
  return c.json(await pageView(getDb(), actor, context, page));
});

/** Revisions of a page; of a page in the trash only for its space's editors. */
async function pageForHistory(principal: Principal, pageId: string) {
  const [page] = await getDb().select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw notFound("No such page");
  const context = await spaceContext(getDb(), principal, await getSpaceById(getDb(), page.spaceId));
  const visibility = spaceVisibility(context);
  await visibility.assertPage(getDb(), page);
  if (page.deletedAt && !visibility.seesTrash(page.spaceId)) throw notFound("No such page");
  return { page, context };
}

router.get("/pages/:id/revisions", async (c) => {
  const principal = requirePrincipal(c);
  const { page } = await pageForHistory(principal, idParam(c));
  const query = queryOf(c, revisionListQuerySchema);
  return c.json(await listRevisions(getDb(), principal, page.id, query));
});

router.get("/pages/:id/revisions/:number", async (c) => {
  const principal = requirePrincipal(c);
  const { page } = await pageForHistory(principal, idParam(c));
  return c.json(await getRevision(getDb(), principal, page.id, revisionParam(c)));
});

/** Saves an old revision's file as the newest version (through the page core). */
router.post("/pages/:id/revisions/:number/restore", async (c) => {
  const actor = requireUser(c);
  const input = await jsonBody(c, revisionRestoreSchema);
  const pageId = idParam(c);
  const number = revisionParam(c);
  const { page, context } = await getDb().transaction(async (tx) => {
    const loaded = await loadPage(tx, actor, pageId, { lock: true });
    requireAbility(loaded.context, "editLive");
    const markdown = await revisionMarkdown(tx, pageId, number);
    if (markdown === null) throw notFound("No such revision");
    const saved = await saveLivePage(tx, {
      space: loaded.context.space,
      page: loaded.page,
      markdown,
      baseRevision: input.baseRevision,
      author: authorOf(actor, "restore", { message: `Restored revision ${number}` }),
    });
    return { page: saved.page, context: loaded.context };
  });
  return c.json(await pageView(getDb(), actor, context, page));
});

/** The web editor's lock routes: live editing only, so editors in the web app. */
async function lockContext(actor: UserPrincipal, pageId: string, tx: DbOrTx) {
  const loaded = await loadPage(tx, actor, pageId, { lock: true });
  requireAbility(loaded.context, "editLive");
  return loaded;
}

router.post("/pages/:id/lock", async (c) => {
  const actor = requireWebUser(c);
  const pageId = idParam(c);
  const lock = await getDb().transaction(async (tx) => {
    await lockContext(actor, pageId, tx);
    return acquireLock(tx, pageId, actor.id);
  });
  return c.json(lock);
});

router.post("/pages/:id/lock/renew", async (c) => {
  const actor = requireWebUser(c);
  const input = await jsonBody(c, lockRenewSchema);
  const pageId = idParam(c);
  const result = await getDb().transaction(async (tx) => {
    await lockContext(actor, pageId, tx);
    return renewLock(tx, pageId, actor.id, input);
  });
  return c.json(result);
});

router.post("/pages/:id/lock/takeover", async (c) => {
  const actor = requireWebUser(c);
  const pageId = idParam(c);
  const lock = await getDb().transaction(async (tx) => {
    await lockContext(actor, pageId, tx);
    return takeOverLock(tx, pageId, actor.id);
  });
  return c.json(lock);
});

router.delete("/pages/:id/lock", async (c) => {
  const actor = requireWebUser(c);
  const pageId = idParam(c);
  const token = c.req.query("token") ?? "";
  if (/^[0-9a-f-]{36}$/i.test(token)) {
    await getDb().transaction(async (tx) => {
      await loadPage(tx, actor, pageId);
      await releaseLock(tx, pageId, token);
    });
  }
  return c.body(null, 204);
});

router.get("/pages/:id/draft", async (c) => {
  const actor = requireWebUser(c);
  const pageId = idParam(c);
  await loadPage(getDb(), actor, pageId);
  const [draft] = await getDb()
    .select()
    .from(drafts)
    .where(and(eq(drafts.pageId, pageId), eq(drafts.userId, actor.id)));
  if (!draft) throw notFound("No draft");
  return c.json({
    markdown: draft.markdown,
    baseRevision: draft.baseRevision,
    updatedAt: iso(draft.updatedAt),
  });
});

router.put("/pages/:id/draft", async (c) => {
  const actor = requireWebUser(c);
  const input = await jsonBody(c, draftPutSchema);
  const pageId = idParam(c);
  const { context } = await loadPage(getDb(), actor, pageId);
  requireAbility(context, "editLive");
  const [draft] = await getDb()
    .insert(drafts)
    .values({ pageId, userId: actor.id, markdown: input.markdown, baseRevision: input.baseRevision })
    .onConflictDoUpdate({
      target: [drafts.pageId, drafts.userId],
      set: { markdown: input.markdown, baseRevision: input.baseRevision, updatedAt: sql`now()` },
    })
    .returning();
  await markFilesUsed(getDb(), [input.markdown]);
  return c.json({
    markdown: draft!.markdown,
    baseRevision: draft!.baseRevision,
    updatedAt: iso(draft!.updatedAt),
  });
});

router.delete("/pages/:id/draft", async (c) => {
  const actor = requireWebUser(c);
  const pageId = idParam(c);
  await getDb()
    .delete(drafts)
    .where(and(eq(drafts.pageId, pageId), eq(drafts.userId, actor.id)));
  return c.body(null, 204);
});

export default router;
