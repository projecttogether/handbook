import { Hono, type Context } from "hono";
import {
  changeSetCreateSchema,
  changeSetEditPageSchema,
  changeSetListQuerySchema,
  changeSetMovePageSchema,
  changeSetPutPageSchema,
  changeSetUpdateSchema,
  commentSchema,
  submitSchema,
} from "@handbook/shared/api/changes";
import { z } from "zod";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { AppError, notFound } from "../http/errors";
import { idParam, jsonBody, numberParam, queryOf, requireUser } from "../http/middleware";
import type { UserPrincipal } from "../auth/principal";
import { loadChangeSet, resolveInChangeSet } from "../changes/model";
import { changeSetDetail, changeSetPageView, listChangeSets } from "../changes/view";
import {
  addComment,
  closeChangeSet,
  createChangeSet,
  deletePage,
  dropItem,
  editPage,
  movePage,
  putPage,
  rebaseItem,
  reopenChangeSet,
  requestChanges,
  submitChangeSet,
  updateChangeSet,
} from "../changes/service";
import { mergeChangeSet, revertChangeSet } from "../changes/merge";
import { and, eq, isNull } from "drizzle-orm";
import { changeSetItems, pages } from "../db/schema";

const router = new Hono<AppEnv>();

async function detail(principal: UserPrincipal, number: number) {
  return changeSetDetail(getDb(), await loadChangeSet(getDb(), principal, number));
}

/** Runs a change and answers with the change set as it is afterwards. */
function mutation(run: (c: Context<AppEnv>, principal: UserPrincipal, number: number) => Promise<unknown>) {
  return async (c: Context<AppEnv>) => {
    const principal = requireUser(c);
    const number = numberParam(c);
    await run(c, principal, number);
    return c.json(await detail(principal, number));
  };
}

router.get("/change-sets", async (c) => {
  const principal = requireUser(c);
  const query = queryOf(c, changeSetListQuerySchema);
  return c.json({ items: await listChangeSets(getDb(), principal, query) });
});

router.post("/change-sets", async (c) => {
  const principal = requireUser(c);
  const input = await jsonBody(c, changeSetCreateSchema);
  const created = await createChangeSet(getDb(), principal, input);
  return c.json(await detail(principal, created.number), 201);
});

router.get("/change-sets/:number", async (c) => {
  const principal = requireUser(c);
  return c.json(await detail(principal, numberParam(c)));
});

router.patch(
  "/change-sets/:number",
  mutation(async (c, principal, number) =>
    updateChangeSet(getDb(), principal, number, await jsonBody(c, changeSetUpdateSchema)),
  ),
);

/** A page inside the change set by path (as the change set sees it); 404 when it does not change it. */
router.get("/change-sets/:number/pages/by-path", async (c) => {
  const principal = requireUser(c);
  const { path } = queryOf(c, z.object({ path: z.string().trim().min(1).max(400) }));
  const access = await loadChangeSet(getDb(), principal, numberParam(c));
  const found = await resolveInChangeSet(getDb(), access.changeSet, path);
  let item = found.item;
  if (!item && found.live) {
    const [row] = await getDb()
      .select()
      .from(changeSetItems)
      .where(
        and(eq(changeSetItems.changeSetId, access.changeSet.id), eq(changeSetItems.pageId, found.live.id)),
      );
    item = row ?? null;
  }
  if (!item) {
    const [moved] = await getDb()
      .select({ path: changeSetItems.path })
      .from(changeSetItems)
      .innerJoin(pages, eq(pages.id, changeSetItems.pageId))
      .where(
        and(
          eq(changeSetItems.changeSetId, access.changeSet.id),
          eq(pages.path, path),
          eq(pages.spaceId, access.changeSet.spaceId),
          isNull(pages.deletedAt),
        ),
      );
    if (moved) {
      throw new AppError(404, "moved_in_change_set", `This change set moves that page to “${moved.path}”`);
    }
    throw notFound("This change set does not change a page at that path");
  }
  return c.json(await changeSetPageView(getDb(), item));
});

router.get("/change-sets/:number/pages/:pageId", async (c) => {
  const principal = requireUser(c);
  const access = await loadChangeSet(getDb(), principal, numberParam(c));
  const pageId = idParam(c, "pageId");
  const [item] = await getDb()
    .select()
    .from(changeSetItems)
    .where(and(eq(changeSetItems.changeSetId, access.changeSet.id), eq(changeSetItems.pageId, pageId)));
  if (!item) throw notFound("This change set does not change that page");
  return c.json(await changeSetPageView(getDb(), item));
});

router.put(
  "/change-sets/:number/pages",
  mutation(async (c, principal, number) =>
    putPage(getDb(), principal, number, await jsonBody(c, changeSetPutPageSchema)),
  ),
);

router.post(
  "/change-sets/:number/pages/:pageId/edit",
  mutation(async (c, principal, number) =>
    editPage(
      getDb(),
      principal,
      number,
      idParam(c, "pageId"),
      (await jsonBody(c, changeSetEditPageSchema)).edits,
    ),
  ),
);

router.post(
  "/change-sets/:number/pages/:pageId/move",
  mutation(async (c, principal, number) =>
    movePage(
      getDb(),
      principal,
      number,
      idParam(c, "pageId"),
      (await jsonBody(c, changeSetMovePageSchema)).path,
    ),
  ),
);

router.post(
  "/change-sets/:number/pages/:pageId/delete",
  mutation(async (c, principal, number) => deletePage(getDb(), principal, number, idParam(c, "pageId"))),
);

router.post(
  "/change-sets/:number/pages/:pageId/rebase",
  mutation(async (c, principal, number) => rebaseItem(getDb(), principal, number, idParam(c, "pageId"))),
);

router.delete(
  "/change-sets/:number/pages/:pageId",
  mutation(async (c, principal, number) => dropItem(getDb(), principal, number, idParam(c, "pageId"))),
);

router.post(
  "/change-sets/:number/comments",
  mutation(async (c, principal, number) =>
    addComment(getDb(), principal, number, (await jsonBody(c, commentSchema)).body),
  ),
);

router.post(
  "/change-sets/:number/submit",
  mutation(async (c, principal, number) =>
    submitChangeSet(getDb(), principal, number, (await jsonBody(c, submitSchema)).note),
  ),
);

router.post(
  "/change-sets/:number/request-changes",
  mutation(async (c, principal, number) =>
    requestChanges(getDb(), principal, number, (await jsonBody(c, commentSchema)).body),
  ),
);

router.post(
  "/change-sets/:number/merge",
  mutation(async (_c, principal, number) => mergeChangeSet(getDb(), principal, number)),
);

router.post(
  "/change-sets/:number/close",
  mutation(async (_c, principal, number) => closeChangeSet(getDb(), principal, number)),
);

router.post(
  "/change-sets/:number/reopen",
  mutation(async (_c, principal, number) => reopenChangeSet(getDb(), principal, number)),
);

router.post("/change-sets/:number/revert", async (c) => {
  const principal = requireUser(c);
  return c.json(await revertChangeSet(getDb(), principal, numberParam(c)));
});

export default router;
