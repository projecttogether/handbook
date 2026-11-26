import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ChangeSetCreate } from "@handbook/shared/api/changes";
import { applyEdits, lineStats, mergeText, type TextEdit } from "@handbook/shared/merge";
import { parentPath, pathProblem } from "@handbook/shared/paths";
import type { Db, DbOrTx } from "../db/client";
import { changeSetItems, changeSets, pages } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { conflict, notFound, validationError } from "../http/errors";
import { markFilesUsed } from "../files/storage";
import { requireAbility, spaceContext } from "../spaces/access";
import { spaceVisibility } from "../spaces/visibility";
import { canonicalize, revisionMarkdown, type PageRow } from "../pages/core";
import {
  addEvent,
  effectivePaths,
  itemsOf,
  livePageById,
  loadChangeSet,
  requireAccess,
  resolveInChangeSet,
  revisionPath,
  targetPathOf,
  titleOf,
  visibleLive,
  type ChangeSetAccess,
  type ChangeSetRow,
  type ItemRow,
} from "./model";

/**
 * Writes to change sets: their pages (items), comments and status. Every
 * change records an event; the live pages stay untouched until a merge
 * (merge.ts).
 */

async function touch(tx: DbOrTx, changeSet: ChangeSetRow) {
  await tx
    .update(changeSets)
    .set({ updatedAt: sql`now()` })
    .where(eq(changeSets.id, changeSet.id));
}

export async function createChangeSet(
  db: Db,
  principal: UserPrincipal,
  input: ChangeSetCreate,
): Promise<ChangeSetRow> {
  return db.transaction(async (tx) => {
    const context = await spaceContext(tx, principal, input.space);
    requireAbility(context, "propose");
    const [row] = await tx
      .insert(changeSets)
      .values({
        spaceId: context.space.id,
        title: input.title,
        description: input.description,
        authorId: principal.id,
        channel: principal.channel,
        clientName: principal.clientName,
      })
      .returning();
    await markFilesUsed(tx, [input.description]);
    await addEvent(tx, row!, principal, { kind: "created" });
    return row!;
  });
}

export async function updateChangeSet(
  db: Db,
  principal: UserPrincipal,
  number: number,
  input: { title?: string; description?: string },
) {
  await db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "edit");
    await tx
      .update(changeSets)
      .set({ ...input, updatedAt: sql`now()` })
      .where(eq(changeSets.id, access.changeSet.id));
    await markFilesUsed(tx, [input.description]);
  });
}

async function itemOf(tx: DbOrTx, changeSetId: string, pageId: string): Promise<ItemRow | null> {
  const [item] = await tx
    .select()
    .from(changeSetItems)
    .where(and(eq(changeSetItems.changeSetId, changeSetId), eq(changeSetItems.pageId, pageId)));
  return item ?? null;
}

/** The item (if any) and live page (if any) a page id names in this change set; 404 when neither. */
async function targetById(tx: DbOrTx, access: ChangeSetAccess, pageId: string) {
  const item = await itemOf(tx, access.changeSet.id, pageId);
  const live = await visibleLive(tx, access, await livePageById(tx, access.changeSet.spaceId, pageId));
  if (!item && !live) throw notFound("No such page in this space");
  return { item, live };
}

function checkPathSyntax(path: string) {
  const problem = pathProblem(path);
  if (problem) throw validationError({ path: problem }, problem);
}

/** 422 below a draft the principal may not see: for it, that parent does not exist. */
async function checkPathVisible(tx: DbOrTx, access: ChangeSetAccess, path: string) {
  if (await spaceVisibility(access.context).canSeePath(tx, access.changeSet.spaceId, path)) return;
  const message = `The parent page “${parentPath(path)}” does not exist`;
  throw validationError({ path: message }, message);
}

/** 409 when another page has `path` after this change set (another item, or an untouched live page). */
async function checkPathFree(tx: DbOrTx, changeSet: ChangeSetRow, pageId: string, path: string) {
  const items = await itemsOf(tx, changeSet.id);
  const paths = await effectivePaths(tx, items);
  if (
    items.some(
      (item) => item.pageId !== pageId && item.action !== "delete" && paths.get(item.pageId) === path,
    )
  ) {
    throw conflict(`Another page in this change set has the path “${path}”`, "path_taken");
  }
  const [live] = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.spaceId, changeSet.spaceId), eq(pages.path, path), sql`${pages.deletedAt} is null`));
  if (live && live.id !== pageId && !items.some((item) => item.pageId === live.id)) {
    throw conflict(`A page with the path “${path}” exists already`, "path_taken");
  }
}

type Upsert = {
  pageId: string;
  action: "create" | "update" | "delete";
  baseRevision: number | null;
  path: string;
  markdown: string | null;
};

/** Stores an item, or removes it when it would not change the live page. Records an edit event. */
async function saveItem(
  tx: DbOrTx,
  access: ChangeSetAccess,
  principal: UserPrincipal,
  previous: { item: ItemRow | null; live: PageRow | null },
  next: Upsert,
  describe: (title: string) => string,
): Promise<ItemRow | null> {
  const { changeSet } = access;
  const live = previous.live;
  const unchanged =
    next.action === "update" && live !== null && next.markdown === live.markdown && next.path === live.path;
  const title = titleOf(next.markdown) ?? titleOf(previous.item?.markdown) ?? live?.title ?? next.path;
  let stored: ItemRow | null = null;
  if (unchanged) {
    await tx
      .delete(changeSetItems)
      .where(and(eq(changeSetItems.changeSetId, changeSet.id), eq(changeSetItems.pageId, next.pageId)));
  } else {
    const values = {
      action: next.action,
      baseRevision: next.baseRevision,
      path: next.path,
      markdown: next.markdown,
      updatedById: principal.id,
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(changeSetItems)
      .values({ changeSetId: changeSet.id, pageId: next.pageId, ...values })
      .onConflictDoUpdate({ target: [changeSetItems.changeSetId, changeSetItems.pageId], set: values })
      .returning();
    stored = row!;
    await markFilesUsed(tx, [next.markdown]);
  }
  await addEvent(tx, changeSet, principal, {
    kind: "edited",
    body: unchanged ? `Undid the changes to “${title}”` : describe(title),
    page: { id: next.pageId, path: next.path, title },
  });
  await touch(tx, changeSet);
  return stored;
}

function statsText(before: string, after: string) {
  const stats = lineStats(before, after);
  return `+${stats.added} −${stats.removed}`;
}

/**
 * Puts a whole page file into a change set: an existing page (by id, or by
 * its path inside the change set) is updated, a new path creates a page.
 * `newPath` also moves an existing page.
 */
export async function putPage(
  db: Db,
  principal: UserPrincipal,
  number: number,
  input: { pageId?: string; path?: string; markdown: string; baseRevision?: number },
): Promise<ItemRow | null> {
  return db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "edit");
    const space = access.context.space;
    const file = canonicalize(input.markdown, space).markdown;
    let target: { item: ItemRow | null; live: PageRow | null };
    if (input.pageId) {
      target = await targetById(tx, access, input.pageId);
    } else {
      checkPathSyntax(input.path!);
      // Before resolving: below a hidden draft, taken and free paths answer alike.
      await checkPathVisible(tx, access, input.path!);
      target = await resolveInChangeSet(tx, access.changeSet, input.path!);
      if (target.live && !(await visibleLive(tx, access, target.live))) {
        throw notFound("No such page in this space");
      }
    }
    const { item, live } = target;
    if (input.pageId && input.path) checkPathSyntax(input.path);

    if (!item && !live) {
      const path = input.path!;
      const pageId = randomUUID();
      await checkPathFree(tx, access.changeSet, pageId, path);
      return saveItem(
        tx,
        access,
        principal,
        target,
        { pageId, action: "create", baseRevision: null, path, markdown: file },
        (title) => `Added “${title}” at ${path}`,
      );
    }
    if (item?.action === "create") {
      const path = input.pageId && input.path ? input.path : item.path;
      if (path !== item.path) {
        await checkPathVisible(tx, access, path);
        await checkPathFree(tx, access.changeSet, item.pageId, path);
      }
      return saveItem(
        tx,
        access,
        principal,
        target,
        { pageId: item.pageId, action: "create", baseRevision: null, path, markdown: file },
        (title) => `Changed the new page “${title}” (${statsText(item.markdown ?? "", file)})`,
      );
    }
    if (!live) throw notFound("This page was deleted meanwhile");
    // Where the page ends up now (an item without a move follows live moves).
    const currentPath = item ? (await effectivePaths(tx, [item])).get(item.pageId)! : live.path;
    const requested = input.pageId && input.path ? input.path : null;
    const moving = requested !== null && requested !== currentPath;
    if (moving) {
      await checkPathVisible(tx, access, requested);
      await checkPathFree(tx, access.changeSet, live.id, requested);
    }
    const path = moving ? requested : (item?.path ?? live.path);
    const before = item?.markdown ?? live.markdown;
    // A new item starts from the revision the file was written from.
    let baseRevision = item?.baseRevision ?? live.revision;
    if (!item && input.baseRevision !== undefined && input.baseRevision !== live.revision) {
      if (
        input.baseRevision > live.revision ||
        (await revisionMarkdown(tx, live.id, input.baseRevision)) === null
      ) {
        throw conflict("This revision of the page does not exist", "invalid_revision");
      }
      baseRevision = input.baseRevision;
    }
    return saveItem(
      tx,
      access,
      principal,
      target,
      {
        pageId: live.id,
        action: "update",
        baseRevision,
        path,
        markdown: file,
      },
      (title) => (moving ? `Moved “${title}” to ${path}` : `Changed “${title}” (${statsText(before, file)})`),
    );
  });
}

/** Applies exact text replacements to a page inside the change set (as coding agents edit files). */
export async function editPage(
  db: Db,
  principal: UserPrincipal,
  number: number,
  pageId: string,
  edits: TextEdit[],
) {
  return db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "edit");
    const target = await targetById(tx, access, pageId);
    if (target.item?.action === "delete") {
      throw conflict("This change set deletes the page; undo the deletion first", "page_deleted");
    }
    const current = target.item?.markdown ?? target.live!.markdown;
    const result = applyEdits(current, edits);
    if (!result.ok)
      throw validationError({ [`edits.${result.index}.oldText`]: result.message }, result.message);
    const file = canonicalize(result.text, access.context.space).markdown;
    const action = target.item?.action === "create" ? "create" : "update";
    return saveItem(
      tx,
      access,
      principal,
      target,
      {
        pageId,
        action,
        baseRevision: action === "create" ? null : (target.item?.baseRevision ?? target.live!.revision),
        path: target.item?.path ?? target.live!.path,
        markdown: file,
      },
      (title) => `Edited “${title}” (${statsText(current, file)})`,
    );
  });
}

export async function movePage(
  db: Db,
  principal: UserPrincipal,
  number: number,
  pageId: string,
  path: string,
) {
  return db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "edit");
    checkPathSyntax(path);
    const target = await targetById(tx, access, pageId);
    if (target.item?.action === "delete") {
      throw conflict("This change set deletes the page; undo the deletion first", "page_deleted");
    }
    await checkPathVisible(tx, access, path);
    await checkPathFree(tx, access.changeSet, pageId, path);
    const action = target.item?.action === "create" ? "create" : "update";
    return saveItem(
      tx,
      access,
      principal,
      target,
      {
        pageId,
        action,
        baseRevision: action === "create" ? null : (target.item?.baseRevision ?? target.live!.revision),
        path,
        markdown: target.item?.markdown ?? target.live!.markdown,
      },
      (title) => `Moved “${title}” to ${path}`,
    );
  });
}

export async function deletePage(db: Db, principal: UserPrincipal, number: number, pageId: string) {
  return db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "edit");
    const target = await targetById(tx, access, pageId);
    const title = titleOf(target.item?.markdown) ?? target.live?.title ?? target.item?.path ?? "";
    if (target.item?.action === "create") {
      await tx
        .delete(changeSetItems)
        .where(and(eq(changeSetItems.changeSetId, access.changeSet.id), eq(changeSetItems.pageId, pageId)));
      await addEvent(tx, access.changeSet, principal, {
        kind: "edited",
        body: `Removed the new page “${title}”`,
        page: { id: pageId, path: target.item.path, title },
      });
      await touch(tx, access.changeSet);
      return null;
    }
    const live = target.live;
    if (!live) throw notFound("This page was deleted meanwhile");
    return saveItem(
      tx,
      access,
      principal,
      target,
      {
        pageId,
        action: "delete",
        baseRevision: target.item?.baseRevision ?? live.revision,
        path: live.path,
        markdown: null,
      },
      () => `Deleted “${title}”`,
    );
  });
}

/** Takes a page's change out of the change set. */
export async function dropItem(db: Db, principal: UserPrincipal, number: number, pageId: string) {
  await db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "edit");
    const item = await itemOf(tx, access.changeSet.id, pageId);
    if (!item) throw notFound("This change set does not change that page");
    const live = item.action === "create" ? null : await livePageById(tx, access.changeSet.spaceId, pageId);
    const title = titleOf(item.markdown) ?? live?.title ?? item.path;
    await tx
      .delete(changeSetItems)
      .where(and(eq(changeSetItems.changeSetId, access.changeSet.id), eq(changeSetItems.pageId, pageId)));
    await addEvent(tx, access.changeSet, principal, {
      kind: "edited",
      body: `Undid the change to “${title}”`,
      page: { id: pageId, path: item.path, title },
    });
    await touch(tx, access.changeSet);
  });
}

/**
 * "Update from live": the item now starts from the live revision. Changes
 * that do not overlap are combined; overlapping ones become conflict
 * blocks to resolve in the change set.
 */
export async function rebaseItem(db: Db, principal: UserPrincipal, number: number, pageId: string) {
  return db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "edit");
    const item = await itemOf(tx, access.changeSet.id, pageId);
    if (!item) throw notFound("This change set does not change that page");
    if (item.action === "create")
      throw conflict("New pages have no live version to update from", "nothing_to_update");
    const live = await livePageById(tx, access.changeSet.spaceId, pageId);
    if (!live) throw notFound("This page was deleted meanwhile");
    if (item.baseRevision === live.revision) return item;
    let markdown = item.markdown;
    let conflicts = 0;
    if (item.action === "update" && item.markdown !== null && item.baseRevision !== null) {
      const base = (await revisionMarkdown(tx, pageId, item.baseRevision)) ?? live.markdown;
      const merged = mergeText(base, item.markdown, live.markdown);
      conflicts = merged.conflicts;
      markdown = merged.clean ? canonicalize(merged.text, access.context.space).markdown : merged.text;
    }
    // Without a move of its own, the item follows a move saved live meanwhile.
    const basePath = item.baseRevision !== null ? await revisionPath(tx, pageId, item.baseRevision) : null;
    const path = targetPathOf(item, basePath, live.path);
    const values = {
      baseRevision: live.revision,
      markdown,
      path,
      updatedById: principal.id,
      updatedAt: new Date(),
    };
    const [row] = await tx
      .update(changeSetItems)
      .set(values)
      .where(and(eq(changeSetItems.changeSetId, access.changeSet.id), eq(changeSetItems.pageId, pageId)))
      .returning();
    const title = titleOf(markdown) ?? live.title;
    await addEvent(tx, access.changeSet, principal, {
      kind: "edited",
      body:
        conflicts > 0
          ? `Updated “${title}” from the live page; ${conflicts} conflict block${conflicts === 1 ? "" : "s"} to resolve`
          : `Updated “${title}” from the live page`,
      page: { id: pageId, path: item.path, title },
    });
    await touch(tx, access.changeSet);
    return row!;
  });
}

export async function addComment(db: Db, principal: UserPrincipal, number: number, body: string) {
  await db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "comment");
    await addEvent(tx, access.changeSet, principal, { kind: "comment", body });
    await touch(tx, access.changeSet);
  });
}

async function setStatus(
  tx: DbOrTx,
  changeSet: ChangeSetRow,
  values: Partial<typeof changeSets.$inferInsert>,
) {
  await tx
    .update(changeSets)
    .set({ ...values, updatedAt: sql`now()` })
    .where(eq(changeSets.id, changeSet.id));
}

export async function submitChangeSet(db: Db, principal: UserPrincipal, number: number, note?: string) {
  await db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "submit");
    if ((await itemsOf(tx, access.changeSet.id)).length === 0) {
      throw conflict("Change at least one page before asking for review", "empty_change_set");
    }
    await setStatus(tx, access.changeSet, { status: "in_review", submittedAt: new Date() });
    await addEvent(tx, access.changeSet, principal, { kind: "submitted", body: note ?? null });
  });
}

export async function requestChanges(db: Db, principal: UserPrincipal, number: number, body: string) {
  await db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "review");
    await setStatus(tx, access.changeSet, { status: "open" });
    await addEvent(tx, access.changeSet, principal, { kind: "changes_requested", body });
  });
}

export async function closeChangeSet(db: Db, principal: UserPrincipal, number: number) {
  await db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "close");
    await setStatus(tx, access.changeSet, { status: "closed", closedAt: new Date() });
    await addEvent(tx, access.changeSet, principal, { kind: "closed" });
  });
}

export async function reopenChangeSet(db: Db, principal: UserPrincipal, number: number) {
  await db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "reopen");
    await setStatus(tx, access.changeSet, { status: "open", closedAt: null });
    await addEvent(tx, access.changeSet, principal, { kind: "reopened" });
  });
}
